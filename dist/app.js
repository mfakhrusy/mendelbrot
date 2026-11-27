import { fromDecimal, toNumber, offsetInteger } from './math.js';
import { vertex, fragment } from './shaders.js';
import { recursiveFrame } from './recursive-zoom.js';
const $ = id => document.getElementById(id);
const canvas = $('fractal');
const gl = canvas.getContext('webgl2', {alpha:false, antialias:false, depth:false, powerPreference:'high-performance'});
const INITIAL = {x:'-0.7482409297559107', y:'0.13646638958862622', depth:7.5};
let bits=192, cx=0n, cy=0n, depth=INITIAL.depth, iterations=900;
let playing=!matchMedia('(prefers-reduced-motion: reduce)').matches, palette=0, speed=.3;
let orbit=null, pending=null, requestId=0, lastTime=0, lastDraw=0, lastTrack=depth, lastStats=0;
let guided=true, target='seahorse', dragging=false, holding=false, recovery=0, frameCount=0, renderScale=.8;
let forceDraw=true, failure=null, gpuMs=0, skipped=0;
function fail(message) {failure=message; $('error').hidden=false;$('error').textContent=message;$('engine').textContent='Unavailable';}
if(!gl) fail('This simulation needs WebGL 2. Please enable hardware acceleration in your browser, then reload this page.');
else initialize();
function initialize() {
  function compile(type,source) { const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));return s; }
  try {
    const program=gl.createProgram();gl.attachShader(program,compile(gl.VERTEX_SHADER,vertex));gl.attachShader(program,compile(gl.FRAGMENT_SHADER,fragment));gl.linkProgram(program);
    if(!gl.getProgramParameter(program,gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);
    const position=gl.getAttribLocation(program,'aPosition');gl.enableVertexAttribArray(position);gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);
    const uniforms={};for(const n of ['uOrbit','uResolution','uAspect','uExponent','uFraction','uOffset','uIterations','uLength','uProbe','uPalette','uStart','uDerivative','uDerivativeExponent','uSkipped','uPreperiod','uPeriod','uColorPhase'])uniforms[n]=gl.getUniformLocation(program,n);
    const orbitTexture=gl.createTexture();gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,orbitTexture);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);gl.uniform1i(uniforms.uOrbit,0);
    const N=80, probeTexture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,probeTexture);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,N,N,0,gl.RGBA,gl.UNSIGNED_BYTE,null);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
    const probeFramebuffer=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,probeFramebuffer);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,probeTexture,0);gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    const pixels=new Uint8Array(N*N*4);
    const timer=gl.getExtension('EXT_disjoint_timer_query_webgl2');
    let gpuQuery=null, resizeAt=0;
    const worker=new Worker('/orbit-worker.js?v=recursive-2',{type:'module'});
    worker.onerror=()=>fail('The precision worker could not start. Reload to try again.');
    worker.onmessage=({data:m})=>{
      if(!pending || m.id!==pending.id) return;
      const snapshot=pending;pending=null;const computedBits=snapshot.bits;
      if(m.error){fail('Precision calculation failed: '+m.error);return;}
      snapshot.x=BigInt(m.x);snapshot.y=BigInt(m.y);
      const height=Math.ceil(m.data.length/4/1024), packed=new Float32Array(1024*height*4);packed.set(m.data);
      gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,orbitTexture);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,1024,height,0,gl.RGBA,gl.FLOAT,packed);
      if(snapshot.bits<bits){const shift=BigInt(bits-snapshot.bits);snapshot.x<<=shift;snapshot.y<<=shift;snapshot.bits=bits;}
      if(guided&&snapshot.target===target){cx=snapshot.x;cy=snapshot.y;}
      orbit={...snapshot,precision:computedBits,length:m.length,ms:m.ms,prefix:m.prefix,model:m.model,periodic:m.periodic};forceDraw=true;$('engine').textContent='Recursive GPU';
    };
    function ensurePrecision() {
      const next=Math.max(192,Math.ceil((depth+128)/64)*64);
      if(next>bits){const shift=BigInt(next-bits);cx<<=shift;cy<<=shift;if(orbit){orbit.x<<=shift;orbit.y<<=shift;orbit.bits=next;}bits=next;}
    }
    function requestOrbit() {
      if(pending) return;
      ensurePrecision();
      const snapshot={id:++requestId,x:cx,y:cy,bits,depth,iterations,target:guided?target:null};pending=snapshot;
      worker.postMessage({...snapshot,x:cx.toString(),y:cy.toString()});
    }
    function relative(n,exponent) {
      if(n===0n)return 0;
      const negative=n<0n;if(negative)n=-n;
      const length=n.toString(2).length, shift=Math.max(0,length-50);
      return (negative?-1:1)*Number(n>>BigInt(shift))*2**(shift-bits-exponent);
    }
    function configure(width,height,probe) {
      const exponent=Math.floor(2-depth), fraction=2**(2-depth-exponent);
      gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,orbitTexture);
      gl.uniform2f(uniforms.uResolution,width,height);gl.uniform1f(uniforms.uAspect,innerWidth/innerHeight);
      gl.uniform1f(uniforms.uExponent,exponent);gl.uniform1f(uniforms.uFraction,fraction);
      const ox=relative(cx-orbit.x,exponent),oy=relative(cy-orbit.y,exponent);
      gl.uniform2f(uniforms.uOffset,ox,oy);
      gl.uniform1i(uniforms.uLength,orbit.length);gl.uniform1i(uniforms.uIterations,orbit.iterations);gl.uniform1i(uniforms.uProbe,probe);gl.uniform1i(uniforms.uPalette,palette);
      const radiusLog=exponent+Math.log2(Math.hypot(fraction*innerWidth/innerHeight*.5+Math.abs(ox),fraction*.5+Math.abs(oy)));
      let start=0,base=0,dr=0,di=0,de=0;
      if(orbit.model){
        const frame=recursiveFrame(orbit.model,exponent,2**(radiusLog-exponent));
        start=frame.start;base=frame.skipped;
        [dr,di]=frame.derivative.z;de=frame.derivative.exponent;
      }else{
        let lo=1,hi=orbit.length-2;
        while(lo<=hi){const mid=(lo+hi)>>>1;if(radiusLog<orbit.prefix[4*mid+3]){start=mid;lo=mid+1;}else hi=mid-1;}
        dr=orbit.prefix[start*4];di=orbit.prefix[start*4+1];de=orbit.prefix[start*4+2];base=start;
      }
      gl.uniform1i(uniforms.uStart,start);gl.uniform1i(uniforms.uSkipped,base);
      gl.uniform1i(uniforms.uPreperiod,orbit.periodic?.preperiod??0);gl.uniform1i(uniforms.uPeriod,orbit.periodic?.period??0);
      gl.uniform4f(uniforms.uDerivative,Math.fround(dr),dr-Math.fround(dr),Math.fround(di),di-Math.fround(di));gl.uniform1f(uniforms.uDerivativeExponent,de);
      gl.uniform2f(uniforms.uColorPhase,(base*.018)%10,(base*.11)%(2*Math.PI));skipped=base;
    }
    function shiftCamera(dx,dy) {ensurePrecision();cx+=offsetInteger(dx,2-depth,bits);cy+=offsetInteger(dy,2-depth,bits);forceDraw=true;}
    function probe() {
      gl.bindFramebuffer(gl.FRAMEBUFFER,probeFramebuffer);gl.viewport(0,0,N,N);configure(N,N,1);gl.drawArrays(gl.TRIANGLES,0,6);gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,pixels);gl.bindFramebuffer(gl.FRAMEBUFFER,null);
      return pixels;
    }
    function reset(startPlaying=true) {
      bits=192;cx=fromDecimal(INITIAL.x,bits);cy=fromDecimal(INITIAL.y,bits);depth=INITIAL.depth;iterations=900;lastTrack=depth;guided=true;target='seahorse';recovery=0;
      pending=null;orbit=null;requestOrbit();forceDraw=true;if(startPlaying)playing=true;syncPlay();
    }
    function resize() {const ratio=Math.min(devicePixelRatio,1.5)*renderScale;canvas.width=Math.min(1440,Math.round(innerWidth*ratio));canvas.height=Math.round(canvas.width*innerHeight/innerWidth);forceDraw=true;}
    function draw() {
      // GPU timestamps measure completed work, rather than the cheap JS call.
      if(gpuQuery&&gl.getQueryParameter(gpuQuery,gl.QUERY_RESULT_AVAILABLE)){
        if(!gl.getParameter(timer.GPU_DISJOINT_EXT)){
          const sample=gl.getQueryParameter(gpuQuery,gl.QUERY_RESULT)/1e6;gpuMs=gpuMs?gpuMs*.8+sample*.2:sample;
          if(performance.now()-resizeAt>2500){
            const old=renderScale;
            if(gpuMs>13)renderScale=Math.max(.32,renderScale*.85);
            else if(gpuMs<7)renderScale=Math.min(1,renderScale*1.08);
            if(old!==renderScale){resize();resizeAt=performance.now();}
          }
        }
        gl.deleteQuery(gpuQuery);gpuQuery=null;
      }
      const measure=timer&&!gpuQuery;
      if(measure){gpuQuery=gl.createQuery();gl.beginQuery(timer.TIME_ELAPSED_EXT,gpuQuery);}
      gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.viewport(0,0,canvas.width,canvas.height);configure(canvas.width,canvas.height,0);gl.drawArrays(gl.TRIANGLES,0,6);
      if(measure)gl.endQuery(timer.TIME_ELAPSED_EXT);
      frameCount++;forceDraw=false;
    }
    function updateStats() {
      const log10=depth*Math.LOG10E*Math.LN2;
      $('magnification').innerHTML=log10<6?(2**depth).toLocaleString('en-US',{maximumFractionDigits:0})+'<span>×</span>':(10**(log10%1)).toFixed(2)+' <span>× 10<sup>'+Math.floor(log10)+'</sup></span>';
      $('precision').textContent=bits.toLocaleString()+' bits';$('iterations').textContent=(iterations+skipped).toLocaleString();
      $('coordinates').textContent=toNumber(cx,bits).toFixed(12)+(cy<0n?' − ':' + ')+Math.abs(toNumber(cy,bits)).toFixed(12)+'i';
      $('depthTrack').style.width=(10+(depth%64)/64*90)+'%';
      $('status').textContent=holding?'Exploring freely':!playing?'Descent paused':guided?'Descending into seahorse spirals':'Free exploration';
      $('statusDetail').textContent='Every frame is calculated in your browser';
    }
    function tick(now) {
      requestAnimationFrame(tick);if(failure)return;
      const dt=Math.min((now-(lastTime||now))/1000,.12);lastTime=now;
      if(document.hidden){lastDraw=now;return;}
      if(!timer&&playing&&lastDraw>0&&now-lastDraw>40&&now-resizeAt>2500){renderScale=Math.max(.32,renderScale*.85);resize();resizeAt=now;}
      if(orbit&&playing&&!holding&&!dragging&&!$('about').open){
        depth+=dt*speed;
        ensurePrecision();
        iterations=900;
        // The automatic destination is an exact algebraic boundary point.
        // Recursive folding keeps the orbit table and per-pixel work bounded.
        if(!pending&&(bits>orbit.precision || iterations!==orbit.iterations || (!guided&&depth-orbit.depth>1)))requestOrbit();
      }
      const frameInterval=gpuMs>18?1000/30:1000/60;
      if(orbit&&(forceDraw||playing&&!$('about').open)&&now-lastDraw>=frameInterval-.5){draw();lastDraw=now;}
      if(now-lastStats>250){updateStats();lastStats=now;}
    }
    function togglePlay(){playing=!playing;if(playing&&!guided){guided=true;target='seahorse';pending=null;requestOrbit();}syncPlay();}
    function syncPlay(){const text=playing?'Pause zoom':'Resume zoom';$('play').ariaLabel=text;$('play').title=text+' (Space)';$('play').innerHTML=playing?'<svg viewBox="0 0 24 24"><path d="M8 6v12M16 6v12"/></svg>':'<svg viewBox="0 0 24 24"><path d="m8 5 11 7-11 7Z"/></svg>';forceDraw=true;updateStats();}
    $('play').onclick=togglePlay;$('speed').onchange=e=>{const value=Number(e.target.value);if(Number.isFinite(value)&&value>0)speed=value;else e.target.value=String(speed);};
    $('palette').onclick=()=>{palette=(palette+1)%3;forceDraw=true;};$('reset').onclick=()=>reset();
    $('fullscreen').onclick=()=>{if(document.fullscreenElement)document.exitFullscreen().catch(()=>{});else document.documentElement.requestFullscreen().catch(()=>{});};
    $('aboutButton').onclick=()=>$('about').showModal();$('closeAbout').onclick=$('resumeAbout').onclick=()=>$('about').close();
    $('about').onclick=e=>{if(e.target===$('about')){const r=$('about').getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)$('about').close();}};
    addEventListener('keydown',e=>{if(/SELECT|INPUT|TEXTAREA/.test(e.target.tagName)||$('about').open)return;if(e.code==='Space'){e.preventDefault();togglePlay();}if(e.key.toLowerCase()==='r')reset();if(e.key.toLowerCase()==='f')$('fullscreen').click();if(e.key.toLowerCase()==='h')document.body.classList.toggle('immersive');});
    let previous=null, origin=null, gestureDistance=0;const pointers=new Map();
    canvas.addEventListener('pointerdown',e=>{
      canvas.setPointerCapture(e.pointerId);pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
      previous={x:e.clientX,y:e.clientY};origin=previous;gestureDistance=0;
      if(pointers.size===2){const p=[...pointers.values()];gestureDistance=Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y);}
    });
    canvas.addEventListener('pointermove',e=>{if(!pointers.has(e.pointerId))return;pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
      if(pointers.size===2){
        const p=[...pointers.values()],distance=Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y);
        if(gestureDistance){depth=Math.max(-1,depth+Math.log2(distance/gestureDistance));ensurePrecision();forceDraw=true;}
        gestureDistance=distance;
      }else if(origin&&Math.hypot(e.clientX-origin.x,e.clientY-origin.y)>5){
        if(!dragging){dragging=true;holding=true;guided=false;playing=false;syncPlay();}
        shiftCamera(-(e.clientX-previous.x)/innerHeight,(e.clientY-previous.y)/innerHeight);
      }
      previous={x:e.clientX,y:e.clientY};
    });
    function release(e){pointers.delete(e.pointerId);if(pointers.size){origin={...pointers.values().next().value};previous=origin;return;}previous=null;origin=null;holding=false;if(dragging){dragging=false;requestOrbit();}forceDraw=true;}
    canvas.addEventListener('pointerup',release);canvas.addEventListener('pointercancel',release);
    canvas.addEventListener('wheel',e=>{
      e.preventDefault();if(!orbit)return;
      const before=depth,change=Math.max(-1,Math.min(1,-e.deltaY*.003));depth=Math.max(-1,depth+change);ensurePrecision();
      if(!guided){const x=(e.clientX-innerWidth/2)/innerHeight,y=-(e.clientY-innerHeight/2)/innerHeight;shiftCamera(x*(2**(depth-before)-1),y*(2**(depth-before)-1));requestOrbit();}
      forceDraw=true;
      if(bits>orbit.precision)requestOrbit();
    },{passive:false});
    canvas.addEventListener('webglcontextlost',e=>{e.preventDefault();fail('The GPU context was interrupted. Reload this page to restart the descent.');});
    addEventListener('resize',resize);document.addEventListener('visibilitychange',()=>{lastTime=0;lastDraw=0;forceDraw=true;});
    // Read-only diagnostic state and deterministic verification hooks.
    window.fractal={state:()=>({depth,bits,iterations:iterations+skipped,gpuIterations:iterations,recursiveLevel:Math.floor(Math.max(0,skipped-20)/5),speed,playing,guided,recovery,frames:frameCount,pending:!!pending,orbitLength:orbit?.length,referenceMs:orbit?.ms,gpuMs,renderScale,skipped,target:guided?target:null,error:failure,width:canvas.width,height:canvas.height,x:cx.toString(),y:cy.toString()}),
      probe:()=>{if(!orbit)return null;probe();forceDraw=true;return {size:N,data:Array.from(pixels)};},
      setView:(x,y,d)=>{pending=null;depth=d;bits=Math.max(192,Math.ceil((d+128)/64)*64);cx=fromDecimal(x,bits);cy=fromDecimal(y,bits);guided=false;lastTrack=depth;recovery=0;requestOrbit();forceDraw=true;},
      advance:(amount)=>{depth+=amount;ensurePrecision();lastTrack=depth-.34;forceDraw=true;},
      seek:(d)=>{depth=d;iterations=900;pending=null;ensurePrecision();requestOrbit();forceDraw=true;},
      pause:()=>{playing=false;syncPlay();},resume:()=>{playing=true;syncPlay();}};
    reset(false);resize();syncPlay();requestAnimationFrame(tick);
  }catch(e){console.error(e);fail('The renderer could not start: '+e.message);}
}
