# 🚀 AI 深度量化 · 金融专家模型云端微调指南

> 目标：把 Qwen2.5 开源模型用 QLoRA 微调成精通本平台金融领域的专家模型
>（金融问答 / 量化分析解读 / 专业报告生成 / 合规拒答）。
> **本地电脑零计算**——训练与部署全部在云端免费额度完成。

## 技术选型（调研结论）

| 项 | 选择 | 理由 |
| --- | --- | --- |
| 微调框架 | **LLaMA Factory**（或本包 train_qlora.py 直跑 transformers+peft+trl） | 100+ 模型支持、官方 Colab、Qwen 官方文档背书 |
| 基座模型 | **Qwen2.5-1.5B/3B-Instruct**（入门）/ 7B（进阶） | 中文能力强、显存友好、生态完善 |
| 微调技术 | **QLoRA**（4-bit NF4 + LoRA r=16 α=32） | T4 16GB 免费卡即可训 3B/7B |
| 云端训练 | **Google Colab T4（免费）** / **Kaggle 双 T4（30h/周免费）** | 零成本 |
| 部署 | **HF Hub + Inference / Spaces ZeroGPU** / 任意 OpenAI 兼容端点 | 免费额度 |

参考项目：[LLaMA-Factory](https://github.com/hiyouga/LlamaFactory) · [Qwen 官方微调文档](https://qwen.readthedocs.io/en/latest/training/llama_factory.html) · [FinGPT](https://github.com/AI4Finance-Foundation/FinGPT) · [TradingAgents](https://github.com/tauricresearch/tradingagents) · [ai-hedge-fund](https://github.com/virattt/ai-hedge-fund)

## 目录内容

| 文件 | 说明 |
| --- | --- |
| `dataset/fin_seed.jsonl` | 种子指令数据集（48 条，openai messages 格式）：金融概念问答 / 量化解读 / 报告生成 / 合规拒答 |
| `dataset/dataset_info.json` | LLaMA Factory 数据集注册文件 |
| `build_dataset.py` | 数据集生成/扩展脚本（加新语料后重跑） |
| `train_qlora.py` | 云端单文件 QLoRA 训练脚本（Colab/Kaggle 直接跑） |
| `../server/ai/export_corpus.cjs` | 平台语料导出（教学/点赞问答/Agent 报告 → JSONL，用于下一轮训练） |

## 云端训练步骤（约 30-60 分钟）

### 方式 A：Google Colab（最简单，训 1.5B/3B）

1. 打开 [colab.research.google.com](https://colab.research.google.com)，新建笔记本，运行类型选 **T4 GPU**（免费）
2. 上传本目录的 `train_qlora.py` 与 `dataset/fin_seed.jsonl`
3. 依次执行：

```python
!pip install -q transformers datasets peft bitsandbytes trl accelerate huggingface_hub
from huggingface_hub import login
login()  # 粘贴 HF Write Token（在 hf.co/settings/tokens 免费创建，需勾选 write）
```

```python
!python train_qlora.py --data fin_seed.jsonl --base Qwen/Qwen2.5-3B-Instruct --push 你的HF用户名/deep-quant-finance
```

4. 训练完成（3B 约需 20-40 分钟），模型自动合并并推送到你的 HF 仓库

### 方式 B：Kaggle（每周 30h 免费额度，训 7B）

1. 新建 Kaggle Notebook → Settings → Accelerator 选 **GPU T4 ×2** → 开启 Internet
2. 参考方式 A 的步骤（7B 建议加 `--use-7b`，或直接用 Qwen2.5-7B-Instruct + QLoRA）
3. 社区现成 notebook 可参考：Kaggle 搜索 "Qwen2.5 LoRA fine-tune"

### 方式 C：Hugging Face Spaces ZeroGPU

在 HF 创建 Space（Gradio 模板），把训练与体验页面都放进去，ZeroGPU 免费额度按需分配 A100 算力（有每日配额）。

## 训练后部署（三选一）

| 方案 | 配置 | 说明 |
| --- | --- | --- |
| **HF Inference** | 平台 `.env`：`AI_CLOUD_BASE_URL=https://router.huggingface.co/v1`、`AI_CLOUD_API_KEY=hf_xxx`、`AI_CLOUD_MODEL=你的用户名/deep-quant-finance` | 模型推送到 HF 后即有 serverless 推理端点（免费额度/按量） |
| **阿里云百炼 DashScope** | `AI_CLOUD_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1`、`AI_CLOUD_MODEL=qwen2.5-3b-instruct`（或部署你的微调版） | 新用户有免费 token 额度，OpenAI 兼容 |
| **Spaces ZeroGPU** | Gradio 应用挂载合并模型 | 免费 A100 配额，适合体验页 |

## 平台接入（已内置，配环境变量即生效）

1. 复制 `.env` 中被注释的 `AI_CLOUD_*` 三行，填入你的端点与密钥（或直接设系统环境变量）
2. 重启服务：AI 助手页右上角出现 **“🛰️ 云端模型”** 徽章
3. 生效逻辑：云端模型优先回答（自动注入平台实时行情与合规系统提示词）→ 失败/未配置时自动回退本地规则引擎与知识库，永不中断

## 持续迭代（数据飞轮）

1. 用户在 AI 助手页的 👍 点赞问答、🧠 教学条目自动累积在 `data/ai/`
2. 定期运行 `node server/ai/export_corpus.cjs` 导出新一轮语料
3. 上传云端追加训练（LLaMA Factory 支持 LoRA 续训），模型能力随使用增长
4. Agent 团队报告、五因子评分也可作为训练语料（导出脚本已内置）

## 合规红线（写进数据集的硬约束）

模型已被训练为：拒绝推荐个股、拒绝预测短期涨跌、拒绝保证收益、拒绝内幕信息，
并解释原因与引导学习量化知识。数据集中含 20+ 条此类边界样本。请勿删除这些样本。
