import { colorDriftGLSL } from './color-drift.mjs';

const canvas = document.createElement('canvas');
canvas.className = 'paper-background';
canvas.setAttribute('aria-hidden', 'true');
document.body.prepend(canvas);
const gl = canvas.getContext('webgl', { alpha: false, antialias: false, preserveDrawingBuffer: true });
if (gl) {
  const compile = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source); gl.compileShader(shader);
    return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
  };
  const vertex = compile(gl.VERTEX_SHADER, 'attribute vec2 position; varying vec2 uv; void main(){ uv=position*.5+.5; gl_Position=vec4(position,0.,1.); }');
  const fragment = compile(gl.FRAGMENT_SHADER, `precision highp float;
    varying vec2 uv; uniform float time; uniform float amplitude; uniform float grouping; uniform float shapeMode;
    ${colorDriftGLSL}
    void main() {
      float grain = fract(sin(dot(floor(gl_FragCoord.xy), vec2(93.989,67.345))) * 43758.5453);
      vec3 paper = vec3(247.,245.,239.) / 255. - grain * .025;
      gl_FragColor = vec4(driftColor(paper,uv,gl_FragCoord.xy,vec2(1.576),time,amplitude,grouping,shapeMode),1.);
    }`);
  if (vertex && fragment) {
    const program = gl.createProgram();
    gl.attachShader(program,vertex); gl.attachShader(program,fragment); gl.linkProgram(program);
    if (gl.getProgramParameter(program,gl.LINK_STATUS)) start(program);
    else canvas.remove();
  } else canvas.remove();
} else canvas.remove();

function start(program) {
  gl.useProgram(program);
  const buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
  gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program,'position');
  gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);
  const uniforms = Object.fromEntries(['time','amplitude','grouping','shapeMode'].map(key=>[key,gl.getUniformLocation(program,key)]));
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let intensity=100, pace=2.5, grouping=11, mode='shapes', paused=false, frame=0, previous=0, time=0;
  function settings() {
    try {
      const read = (key, fallback, min, max) => {
        const value=localStorage.getItem('homerun:color-'+key);
        return value !== null && value.trim() && Number.isFinite(Number(value)) ? Math.max(min,Math.min(max,Number(value))) : fallback;
      };
      intensity=read('intensity',100,0,100); pace=read('pace',2.5,.25,4); grouping=read('grouping',11,0,100);
      mode=localStorage.getItem('homerun:color-mode') === 'acid' ? 'acid' : 'shapes';
    } catch {}
    render(); sync();
  }
  function render() {
    gl.uniform1f(uniforms.time,time); gl.uniform1f(uniforms.amplitude,reduced.matches ? 0 : intensity*.4);
    gl.uniform1f(uniforms.grouping,grouping/100); gl.uniform1f(uniforms.shapeMode,mode==='shapes'?1:0);
    gl.drawArrays(gl.TRIANGLES,0,6);
    canvas.dataset.ready='true';
  }
  function tick(now) {
    frame=0;
    if (now-previous>=1000/24) { time+=Math.min((now-previous)/1000,.1)*pace; previous=now; render(); }
    frame=requestAnimationFrame(tick);
  }
  function sync() {
    cancelAnimationFrame(frame); frame=0; previous=performance.now();
    if (!document.hidden && !reduced.matches && !paused && intensity>0) frame=requestAnimationFrame(tick);
  }
  function resize() {
    const dpr=Math.min(devicePixelRatio||1,2);
    canvas.width=Math.round(innerWidth*dpr);canvas.height=Math.round(innerHeight*dpr);
    gl.viewport(0,0,canvas.width,canvas.height);render();
  }
  window.addEventListener('resize',resize);
  window.addEventListener('storage',settings);
  document.addEventListener('visibilitychange',sync);
  reduced.addEventListener('change',()=>{render();sync();});
  for (const id of ['color-mode','color-intensity','color-pace','color-grouping']) document.getElementById(id)?.addEventListener(id==='color-mode'?'change':'input',settings);
  document.getElementById('toggle-motion')?.addEventListener('click',()=>{paused=!paused;sync();});
  resize();settings();
}
