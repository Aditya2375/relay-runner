'use strict';
(() => {
  const canvas = document.getElementById('relayCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const pause = document.getElementById('motion');
  const media = matchMedia('(prefers-reduced-motion: reduce)');
  let paused = media.matches, visible = true, frame = null, elapsed = 0, last = 0, w = 1, h = 1;
  let pointer = {x:0,y:0}, eased = {x:0,y:0}, status = 'idle';
  function updateButton() { pause.textContent = paused ? 'Resume motion ▷' : 'Pause motion Ⅱ'; pause.setAttribute('aria-pressed', String(paused)); }
  function project(x,y,z) {
    const mobile = w < 550, s = mobile ? Math.min(w*.16,h*.28) : Math.min(w*.10,h*.29);
    return [(mobile?w*.57:w*.68)+(x*.83-z*.57)*s+eased.x, h*(mobile?.67:.55)+(x*.27+z*.37-y)*s+eased.y];
  }
  function poly(points, fill, stroke='#58604c', width=.7) {
    ctx.beginPath(); points.forEach((p,i) => {const [x,y]=project(...p);i?ctx.lineTo(x,y):ctx.moveTo(x,y)});ctx.closePath();
    if(fill){ctx.fillStyle=fill;ctx.fill()} if(stroke){ctx.strokeStyle=stroke;ctx.lineWidth=width;ctx.stroke()}
  }
  function line(points, color, width=1) {ctx.beginPath();points.forEach((p,i)=>{const q=project(...p);i?ctx.lineTo(...q):ctx.moveTo(...q)});ctx.strokeStyle=color;ctx.lineWidth=width;ctx.stroke()}
  function box(x,y,z,dx,dy,dz,colors,stroke='#798369') {
    poly([[x,y,z+dz],[x+dx,y,z+dz],[x+dx,y+dy,z+dz],[x,y+dy,z+dz]],colors[0],stroke);
    poly([[x+dx,y,z],[x+dx,y,z+dz],[x+dx,y+dy,z+dz],[x+dx,y+dy,z]],colors[1],stroke);
    poly([[x,y+dy,z],[x+dx,y+dy,z],[x+dx,y+dy,z+dz],[x,y+dy,z+dz]],colors[2],stroke);
  }
  function render() {
    ctx.clearRect(0,0,w,h);
    // Engraved datum grid, then raised circuit planes. All geometry is original.
    for(let n=-6;n<=6;n++) {
      line([[-4,-.68,n*.5],[4,-.68,n*.5]],'#2c3226',.55);
      line([[n*.5,-.68,-2.7],[n*.5,-.68,2.8]],'#2c3226',.55);
    }
    const copper=status==='rejected'?'#bba284':'#ff805c';
    poly([[-2.8,-.53,-1.55],[3.1,-.53,-1.55],[3.1,-.53,1.75],[-2.8,-.53,1.75]],'#1d2219','#59624c');
    poly([[-2.7,-.5,-1.45],[3,-.5,-1.45],[3,-.5,1.65],[-2.7,-.5,1.65]],null,'#343e2b');
    // Contact pads along the base give the object an engineered, finite scale.
    for(let i=0;i<17;i++){
      const x=-2.5+i*.31;poly([[x,-.49,1.4],[x+.13,-.49,1.4],[x+.13,-.49,1.58],[x,-.49,1.58]],i%3===0?'#a88660':'#59604a',null);
    }
    for(let j=0;j<6;j++){
      const z=-.8+j*.27;
      line([[-2.15,-.36,z],[-.75,-.36,z],[-.4,-.36,z-.25],[.4,-.36,z-.25],[.8,-.36,z],[2.3,-.36,z]],j===2?copper:'#636b54',j===2?1.5:.7);
    }
    // Input envelope plate, lifted from the base.
    box(-2.25,-.35,-.15,1.1,.23,1.22,['#353c2e','#242c1e','#4a5340'],'#8e997d');
    poly([[-2.1,-.1,.01],[-1.3,-.1,.01],[-1.3,-.1,.91],[-2.1,-.1,.91]],'#252e1e','#879674');
    for(let j=0;j<4;j++)line([[-2,-.09,.15+j*.14],[-1.42,-.09,.15+j*.14]],j===0?copper:'#839174',1.2);
    // A transparent verification gate, raised above both signal tracks.
    box(-.25,-.38,-.7,.5,1.83,1.5,['#543f2e','#342a21','#bb6747'],copper);
    poly([[-.25,-.15,.81],[-.25,1.24,.81],[-.25,1.24,-.49],[-.25,-.15,-.49]],'#2c2a20',copper,1);
    for(let i=0;i<7;i++)line([[-.26,.03+i*.17,-.49],[-.26,.03+i*.17,.8]],'#866346',.8);
    line([[-.26,.54,-.49],[-.26,.54,.8]],'#ffb18c',2);
    // Socket on the output side and short vertical support standoffs.
    box(1.24,-.35,-.7,1.22,.35,1.35,['#303a26','#1d2818','#47563a'],'#91a27e');
    box(1.48,.02,-.46,.74,.11,.86,['#252f1d','#182212','#71865a'],'#a0b887');
    for(let i=0;i<4;i++)for(let j=0;j<3;j++){
      const p=project(1.61+i*.14,.15,-.3+j*.23);ctx.fillStyle=status==='accepted'?'#d4eab2':'#9aab88';ctx.fillRect(p[0]-1,p[1]-1,2,2);
    }
    for(const [x,z] of [[-2.55,-1.2],[2.8,-1.2],[-2.55,1.35],[2.8,1.35]])box(x,-.66,z,.08,.18,.08,['#576447','#3b472e','#9ba98b'],'#747e68');
    // A moving packet is an illustration, not a fabricated operational metric.
    const t=(elapsed*.00018)%1;
    for(let i=0;i<3;i++){
      const phase=(t+i/3)%1;
      if(status==='rejected'&&phase>.49)continue;
      const p=project(-2+phase*4.25,.02,.48);ctx.fillStyle=i===0?'#ffe1bc':copper;ctx.beginPath();ctx.arc(p[0],p[1],i===0?3:1.7,0,Math.PI*2);ctx.fill();
    }
    // Instrument axes and a small datum key.
    const base=project(2.75,-.48,-1.12);ctx.font='8px "Relay Mono", monospace';ctx.fillStyle='#a6b493';ctx.fillText('LOCAL',Math.min(w-45,base[0]-20),base[1]-8);
    if(w>=550){for(const [text,point] of [['01 / REQUEST',[-2.2,-.43,1.2]],['02 / VERIFY',[-.25,1.59,-.5]],['03 / DISPATCH',[1.3,-.42,.87]]]){const p=project(...point);ctx.fillStyle='#d1d7c6';ctx.fillText(text,p[0],p[1]);}}
  }
  function stop(){if(frame!==null)cancelAnimationFrame(frame);frame=null;last=0}
  function tick(now){frame=null;if(paused||!visible||document.hidden)return;if(last)elapsed+=Math.min(now-last,40);last=now;eased.x+=(pointer.x-eased.x)*.05;eased.y+=(pointer.y-eased.y)*.05;render();frame=requestAnimationFrame(tick)}
  function sync(){stop();if(!paused&&visible&&!document.hidden)frame=requestAnimationFrame(tick);else render();updateButton()}
  function resize(){const r=canvas.getBoundingClientRect();w=r.width;h=r.height;const d=Math.min(devicePixelRatio||1,2);canvas.width=Math.round(w*d);canvas.height=Math.round(h*d);ctx.setTransform(d,0,0,d,0,0);render()}
  new ResizeObserver(resize).observe(canvas);new IntersectionObserver(e=>{visible=e[0].isIntersecting;sync()},{threshold:.05}).observe(canvas);
  canvas.parentElement.addEventListener('pointermove',e=>{if(paused)return;const r=canvas.getBoundingClientRect();pointer={x:((e.clientX-r.left)/w-.5)*12,y:((e.clientY-r.top)/h-.5)*7}});
  canvas.parentElement.addEventListener('pointerleave',()=>{pointer={x:0,y:0}});
  pause.addEventListener('click',()=>{paused=!paused;sync()});media.addEventListener('change',()=>{paused=media.matches;sync()});document.addEventListener('visibilitychange',sync);resize();sync();
  const label=document.getElementById('resultLabel'),detail=document.getElementById('resultDetail'),result=document.getElementById('signalResult');
  document.querySelectorAll('[data-experiment]').forEach(button=>button.addEventListener('click',async()=>{
    const all=[...document.querySelectorAll('[data-experiment]')];all.forEach(b=>{b.disabled=true;b.classList.toggle('active',b===button)});
    try{
      const d=globalThis.RelayDemo;if(!d?.state.key)throw Error('Protocol not ready. Reload and try again.');
      const experiment=button.dataset.experiment;
      const job=await d.makeJob('workspace.list',{},d.state.key,experiment==='expired'?Date.now()-180000:Date.now());
      if(experiment==='tamper')job.signature=(job.signature[0]==='0'?'1':'0')+job.signature.slice(1);
      if(experiment==='replay')await d.execute(job);
      try{const value=await d.execute(job);status='accepted';label.textContent='Request accepted';detail.textContent=`Signature, age, task and one-time ID passed. ${value.entries.length} demo entries returned.`;}
      catch(error){status='rejected';label.textContent='Request rejected';detail.textContent=experiment==='tamper'?'Changed signature. The envelope was not dispatched.':experiment==='expired'?'Three-minute-old envelope. The two-minute window has expired.':experiment==='replay'?'This ID was already consumed. The second dispatch was refused.':error.message;}
      result.className='signal-result '+status;render();
    }catch(error){status='rejected';label.textContent='Demo unavailable';detail.textContent=error.message;result.className='signal-result rejected';render()}
    finally{all.forEach(b=>b.disabled=false)}
  }));
  document.getElementById('clearTerminal')?.addEventListener('click',()=>{document.getElementById('termOut').replaceChildren();document.getElementById('termIn').focus()});
  document.getElementById('resetDemo')?.addEventListener('click',()=>{const input=document.getElementById('termIn');if(input.disabled)return;input.value='reset';document.getElementById('termForm').requestSubmit()});
})();
