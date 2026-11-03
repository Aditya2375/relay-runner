(function(){
  var pick=document.getElementById('ospick');if(!pick)return;
  var tabs=pick.querySelectorAll('[role="tab"]');
  var panels=pick.querySelectorAll('.osvideo');
  function detect(){
    var p=(navigator.platform||'')+' '+(navigator.userAgent||'');
    if(/Win/i.test(p))return 'windows';
    if(/Mac|iPhone|iPad/i.test(p))return 'macos';
    return 'linux';
  }
  function show(os,focus){
    tabs.forEach(function(t){var on=t.dataset.os===os;t.setAttribute('aria-selected',on?'true':'false');t.tabIndex=on?0:-1;if(on&&focus)t.focus();});
    panels.forEach(function(f){var on=f.dataset.os===os;f.hidden=!on;if(!on){var v=f.querySelector('video');if(v)v.pause();}});
  }
  tabs.forEach(function(t){
    t.addEventListener('click',function(){show(t.dataset.os,false);});
    t.addEventListener('keydown',function(e){
      if(e.key!=='ArrowLeft'&&e.key!=='ArrowRight')return;
      var arr=Array.prototype.slice.call(tabs),i=arr.indexOf(t);
      var n=e.key==='ArrowRight'?(i+1)%arr.length:(i+arr.length-1)%arr.length;
      show(arr[n].dataset.os,true);e.preventDefault();
    });
  });
  show(detect(),false);
})();
