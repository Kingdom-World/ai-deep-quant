# -*- coding: utf-8 -*-
"""
AI深度量化 · 金融专家模型 QLoRA 微调脚本（云端单文件版）
════════════════════════════════════════════════════════════
适用环境（本地电脑零计算，全部在云端执行）：
  · Google Colab 免费 T4 (16GB) —— 推荐 Qwen2.5-1.5B/3B + 4bit QLoRA
  · Kaggle 双 T4 (30h/周免费额度) —— 可训 7B
  · Hugging Face Spaces ZeroGPU

使用（Colab 单元格）：
  1. 上传本文件 + dataset/fin_seed.jsonl 到云端
  2. !pip install -q transformers datasets peft bitsandbytes trl accelerate huggingface_hub
  3. from huggingface_hub import login; login()   # 粘贴你的 HF Write Token（免费注册）
  4. !python train_qlora.py --data fin_seed.jsonl --base Qwen/Qwen2.5-3B-Instruct --push 你的HF用户名/deep-quant-finance
  5. 训练完成后模型自动合并并推送到你的 HF 仓库（公开/私有自选）

  产出：精通本平台金融领域（概念问答/量化解读/报告生成/合规拒答）的专家模型。
════════════════════════════════════════════════════════════
"""
import argparse, os

def parse_args():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="fin_seed.jsonl", help="训练数据（JSONL, openai messages 格式）")
    ap.add_argument("--base", default="Qwen/Qwen2.5-1.5B-Instruct", help="基座模型")
    ap.add_argument("--out", default="deep-quant-finance-out", help="输出目录")
    ap.add_argument("--push", default="", help="推送到 HF 仓库（如 你的用户名/deep-quant-finance），留空则只保存在本地输出目录")
    ap.add_argument("--epochs", type=float, default=3.0)
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--max-len", type=int, default=1024)
    ap.add_argument("--use-7b", action="store_true", help="切换 7B（建议 Kaggle 双 T4 或更高显存）")
    return ap.parse_args()

def main():
    args = parse_args()
    import torch
    from datasets import Dataset
    from transformers import (AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig,
                              TrainingArguments, pipeline)
    from peft import LoraConfig, prepare_model_for_kbit_training
    from trl import SFTTrainer, SFTConfig
    from huggingface_hub import login as hf_login

    if args.push:
        token = os.environ.get("HF_TOKEN") or input("HF Write Token: ")
        hf_login(token=token)

    base = args.base
    compute_dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
    quant_cfg = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=compute_dtype,
        bnb_4bit_use_double_quant=True,
    )

    print(f"== 加载基座: {base} (4-bit NF4 QLoRA) ==")
    model = AutoModelForCausalLM.from_pretrained(
        base, quantization_config=quant_cfg, device_map="auto",
        torch_dtype=compute_dtype, trust_remote_code=True,
    )
    tokenizer = AutoTokenizer.from_pretrained(base, trust_remote_code=True)
    tokenizer.pad_token = tokenizer.eos_token
    model = prepare_model_for_kbit_training(model)
    model.config.use_cache = False

    lora = LoraConfig(
        r=16, lora_alpha=32, lora_dropout=0.05, bias="none",
        task_type="CAUSAL_LM",
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
    )

    rows = []
    with open(args.data, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line)["messages"])
    print(f"== 训练样本: {len(rows)} 条 ==")
    ds = Dataset.from_dict({"messages": rows})

    train_args = SFTConfig(
        output_dir=args.out,
        per_device_train_batch_size=2,
        gradient_accumulation_steps=8,
        num_train_epochs=args.epochs,
        learning_rate=args.lr,
        lr_scheduler_type="cosine",
        warmup_ratio=0.1,
        logging_steps=5,
        save_strategy="epoch",
        bf16=compute_dtype == torch.bfloat16,
        max_seq_length=args.max_len,
        packing=False,
        report_to="none",
    )
    trainer = SFTTrainer(
        model=model,
        args=train_args,
        train_dataset=ds,
        processing_class=tokenizer,
        peft_config=lora,
    )
    trainer.train()
    trainer.save_model(args.out)

    # 合并 LoRA → 完整模型（部署用）
    print("== 合并 LoRA 并保存完整模型 ==")
    merged = model.merge_and_unload()
    merged.save_pretrained(args.out + "-merged")
    tokenizer.save_pretrained(args.out + "-merged")

    if args.push:
        print(f"== 推送到 HF: {args.push} ==")
        merged.push_to_hub(args.push, private=False)
        tokenizer.push_to_hub(args.push, private=False)
        print("完成。部署选项见 ai-training/README.md")

    # 快速冒烟验证
    pipe = pipeline("text-generation", model=merged, tokenizer=tokenizer, max_new_tokens=256)
    demo = pipe([
        {"role": "system", "content": "你是「AI深度量化」平台的金融研究助手，专为中文用户提供量化研究与教育服务。所有内容属于学术研究演示，不构成任何投资建议。"},
        {"role": "user", "content": "什么是ROE？在选股时怎么看？"},
    ])
    print("== 冒烟回答 ==")
    print(demo[0]["generated_text"][-1]["content"][:400])

if __name__ == "__main__":
    main()
