'use strict';
(() => {
  const tabs = [...document.querySelectorAll('[data-os]')];
  const panels = [...document.querySelectorAll('[data-os-panel]')];
  function show(os, focus=false) {
    tabs.forEach(tab => {const on=tab.dataset.os===os;tab.setAttribute('aria-selected',String(on));tab.tabIndex=on?0:-1;if(on&&focus)tab.focus()});
    panels.forEach(panel => {panel.hidden=panel.dataset.osPanel!==os;if(panel.hidden)panel.querySelectorAll('video').forEach(v=>v.pause())});
  }
  if(tabs.length){
    const platform = navigator.userAgentData?.platform || navigator.platform || '';
    show(/Win/i.test(platform)?'windows':/Mac|iPhone|iPad/i.test(platform)?'macos':'linux');
    tabs.forEach((tab,i)=>{
      tab.addEventListener('click',()=>show(tab.dataset.os));
      tab.addEventListener('keydown',event=>{
        let n;if(event.key==='ArrowRight')n=(i+1)%tabs.length;else if(event.key==='ArrowLeft')n=(i+tabs.length-1)%tabs.length;else if(event.key==='Home')n=0;else if(event.key==='End')n=tabs.length-1;else return;
        event.preventDefault();show(tabs[n].dataset.os,true);
      });
    });
  }
  document.querySelectorAll('.copy-code').forEach(button=>button.addEventListener('click',async()=>{
    const code=button.parentElement.querySelector('code');const text=code.textContent;
    try {if(!navigator.clipboard)throw Error('Clipboard unavailable');await navigator.clipboard.writeText(text);button.textContent='Copied';}
    catch {const selection=getSelection();const range=document.createRange();range.selectNodeContents(code);selection.removeAllRanges();selection.addRange(range);button.textContent='Text selected';}
    setTimeout(()=>{button.textContent='Copy'},2000);
  }));
})();
