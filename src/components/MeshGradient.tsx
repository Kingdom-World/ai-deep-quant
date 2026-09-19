// ─────────────────────────────────────────────────────────────
// MeshGradient —— 全屏 WebGL 流体渐变着色器（Stripe 风格 · 自研实现）
//   原理：simplex noise 多倍频程 + 域扭曲（domain warp），得到持续流动的"液态极光"渐变
//   交互：鼠标位置作为局部光源/扰动，缓慢跟随（现代感的"页面在回应你"）
//   性能：单 fragment shader，devicePixelRatio 上限 1.5；离屏时暂停渲染
//   配色：深空海军 → 深蓝 → 青 → 紫罗兰高光（与平台主色一致）
// ─────────────────────────────────────────────────────────────
import { useEffect, useRef } from 'react';

const VERT = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

const FRAG = `
precision highp float;
uniform vec2 u_res;
uniform float u_time;
uniform vec2 u_mouse; // 归一化 0-1

// ── Ashima simplex noise 3D（MIT，公共标准实现）──
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g; vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857; vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z);
  vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0); m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}
float fbm(vec3 p){
  float v=0.0; float a=0.5;
  for(int i=0;i<5;i++){ v+=a*snoise(p); p*=2.03; a*=0.5; }
  return v;
}

void main(){
  vec2 uv=gl_FragCoord.xy/u_res;
  vec2 p=uv*vec2(u_res.x/u_res.y,1.0);
  float t=u_time*0.032;

  // 鼠标（缓慢跟随，由宿主插值）→ 局部扰动光源
  float md=distance(p,vec2(u_mouse.x*u_res.x/u_res.y,u_mouse.y));
  float mglow=exp(-md*2.6)*0.55;

  // 域扭曲：fbm(p + fbm(p + t)) 产生"液态流动"
  vec3 q=vec3(p*0.62,t);
  float w1=fbm(q+vec3(0.0,0.0,1.7));
  float w2=fbm(q+vec3(5.2,1.3,w1*0.5)+w1*0.32);
  float f=fbm(vec3(p*0.55,t*0.9)+vec3(w2*0.55,w1*0.4,0.0));
  f=f*0.5+0.5;
  f+=mglow*0.35;

  // 配色：深空海军 → 平台蓝 → 青 → 紫罗兰高光
  vec3 cNavy=vec3(0.024,0.031,0.055);
  vec3 cDeep=vec3(0.043,0.086,0.220);
  vec3 cBlue=vec3(0.145,0.345,0.875);
  vec3 cCyan=vec3(0.220,0.741,0.976);
  vec3 cViolet=vec3(0.420,0.290,0.870);

  vec3 col=mix(cNavy,cDeep,smoothstep(0.22,0.60,f));
  col=mix(col,cBlue,smoothstep(0.60,0.85,f)*0.85);
  col=mix(col,cCyan,smoothstep(0.84,1.06,f)*0.55);
  col=mix(col,cViolet,smoothstep(0.78,1.05,w2)*0.20);
  col+=cCyan*mglow*0.22;

  // 亮度呼吸（极缓慢的整体明暗，像活物）
  col*=0.94+0.06*sin(u_time*0.18);

  // 边缘暗角 + 细颗粒
  float vig=smoothstep(1.45,0.35,distance(uv,vec2(0.5,0.42)));
  col*=mix(0.72,1.0,vig);
  float grain=fract(sin(dot(gl_FragCoord.xy,vec2(12.9898,78.233)))*43758.5453);
  col+=(grain-0.5)*0.022;

  gl_FragColor=vec4(col,1.0);
}
`;

function compile(gl: WebGLRenderingContext, type: number, src: string) {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.error('[MeshGradient] shader 编译失败:', gl.getShaderInfoLog(gl));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

export default function MeshGradient({ opacity = 1 }: { opacity?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const gl = canvas.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'high-performance' });
    if (!gl) return; // 不支持 WebGL：保持底色，不阻塞登录
    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return;
    const prog = gl.createProgram();
    if (!prog) return;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error('[MeshGradient] 链接失败:', gl.getProgramInfoLog(prog));
      return;
    }
    gl.useProgram(prog);

    // 全屏两个三角形
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    const uRes = gl.getUniformLocation(prog, 'u_res');
    const uTime = gl.getUniformLocation(prog, 'u_time');
    const uMouse = gl.getUniformLocation(prog, 'u_mouse');

    let raf = 0;
    let running = true;
    let mx = 0.5;
    let my = 0.45;
    let tx = 0.5;
    let ty = 0.45;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      w = canvas.width = Math.round(window.innerWidth * dpr);
      h = canvas.height = Math.round(window.innerHeight * dpr);
      gl.viewport(0, 0, w, h);
    };
    let w = 0;
    let h = 0;
    resize();
    window.addEventListener('resize', resize);

    const onMove = (e: MouseEvent) => {
      tx = e.clientX / window.innerWidth;
      ty = 1 - e.clientY / window.innerHeight;
    };
    window.addEventListener('mousemove', onMove);

    const t0 = performance.now();
    const tick = () => {
      if (!running) return;
      // 鼠标缓慢跟随（插值），避免生硬跳动
      mx += (tx - mx) * 0.035;
      my += (ty - my) * 0.035;
      gl.uniform2f(uRes, w, h);
      gl.uniform1f(uTime, (performance.now() - t0) / 1000);
      gl.uniform2f(uMouse, mx, my);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      raf = requestAnimationFrame(tick);
    };
    tick();

    // 页面不可见时暂停渲染
    const onVis = () => {
      if (document.hidden) {
        running = false;
        cancelAnimationFrame(raf);
      } else if (!running) {
        running = true;
        tick();
      }
    };
    document.addEventListener('visibilitychange', onVis);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      window.removeEventListener('mousemove', onMove);
      document.removeEventListener('visibilitychange', onVis);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    };
  }, []);

  return <canvas ref={ref} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity }} />;
}
