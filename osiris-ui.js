/* OSIRIS UI BRIDGE — mockup blijft de indeling; echte engine (app.js) levert de data.
   1) MOVE : echte interactieve blokken worden fysiek de mockup-tab in verplaatst (werken direct)
   2) PANEL: echte data-containers worden in het bijpassende mockup-paneel gespiegeld
   3) TEXT : elk mockup-element met data-src krijgt de tekst van het echte element
   4) CTRL : mockup-knoppen/toggles roepen de echte app.js-functies aan            */
(function(){
  'use strict';
  var $=function(id){return document.getElementById(id);};
  function txt(id){var e=$(id);return e?(e.textContent||e.innerText||'').trim():null;}

  /* ---- 1) MOVE: echte interactieve blokken naar de mockup ---- */
  var MOVE=[
    ['bot-control-hub','tab-engine'],   // engine-config (alle inputs/selects/toggles) -> Engine-tab
    ['config-body','tab-engine']        // (config-body zit in bot-control-hub; no-op als al verplaatst)
  ];
  function moveBlocks(){
    MOVE.forEach(function(m){
      var el=$(m[0]), dest=$(m[1]);
      if(el && dest && !dest.contains(el)){ el.style.display=''; dest.appendChild(el); }
    });
  }

  /* ---- 2) PANEL: echte container -> mockup-paneel met bijpassende plabel ---- */
  var PANEL={  // plabel-tekst (genormaliseerd) : echte container-id
    'open posities':'hub-positions',
    'pending orders':'pending-orders-list',
    'gesloten posities · historie':'history-body',
    'beredenering (live · scrollbaar)':'reasoning-body',
    'beredenering (live)':'reasoning-body',
    'autonome aanpassing — wat neo zelf aanpast (scrollbaar)':'bot-adaptation',
    'autonome aanpassing — wat neo zelf aanpast':'bot-adaptation',
    'exit · bijdrage':'exit-dist',
    'level 1 · factor-gewichten':'learning-body',
    'level 2 · logistisch model':'cortex-body',
    'level 3 · neuraal net':'l3-body',
    'deepnet-band · live':'deepnet-status',
    'presets per core':'subbrain-presets-body',
    'core zelf-kalibratie (live)':'osiris-shadow-panel'
  };
  var _panels=null;
  function norm(t){return (t||'').replace(/\s+/g,' ').replace(/&middot;/g,'·').replace(/&mdash;/g,'—').trim().toLowerCase();}
  function indexPanels(){
    _panels={};
    var labs=document.querySelectorAll('.panel .plabel, .plabel');
    labs.forEach(function(l){
      // plabel-tekst zonder knoppen
      var t=norm(l.textContent);
      for(var key in PANEL){ if(t.indexOf(key)===0 || t===key){ _panels[key]=l; } }
    });
  }
  function mirrorPanels(){
    if(!_panels) indexPanels();
    for(var key in PANEL){
      var lab=_panels[key], src=$(PANEL[key]);
      if(!lab||!src) continue;
      var host=lab.parentElement;                 // het paneel
      // vind/maak de mirror-container na de plabel
      var box=host.querySelector(':scope > .jv-mirror');
      if(!box){
        box=document.createElement('div'); box.className='jv-mirror';
        // verwijder statische mockup-inhoud ná de plabel
        var n=lab.nextSibling;
        while(n){ var nx=n.nextSibling; host.removeChild(n); n=nx; }
        host.appendChild(box);
      }
      if(box.innerHTML!==src.innerHTML) box.innerHTML=src.innerHTML;
    }
  }

  /* ---- 3) TEXT: scalars ---- */
  function mirrorText(){
    document.querySelectorAll('[data-src]').forEach(function(el){
      var v=txt(el.getAttribute('data-src'));
      if(v!==null&&v!=='') el.textContent=v;
    });
  }

  /* ---- 4) CTRL: knoppen/toggles ---- */
  function wireButtons(){
    document.querySelectorAll('[data-act]').forEach(function(el){
      if(el._w) return; el._w=1;
      el.addEventListener('click',function(){
        var a=el.getAttribute('data-act'),g=el.getAttribute('data-arg');
        try{
          if(a==='fn'&&window[g]) window[g]();
          else if(a==='click'){var t=$(g); if(t)t.click();}
          else if(a==='timeframe'&&window.changeTimeframe) window.changeTimeframe(g);
          else if(a==='coin'&&window.switchCoin) window.switchCoin(g);
        }catch(e){console.warn('bridge',a,g,e);}
      });
    });
  }
  // mockup coin/markt-toggles ook de echte switchCoin laten aanroepen
  function wrapCoinFns(){
    ['setChartMkt','setSys','setHistMkt'].forEach(function(fn){
      var o=window[fn];
      window[fn]=function(m,el){ try{if(o)o(m,el);}catch(e){} try{if(window.switchCoin)window.switchCoin(m);}catch(e){} };
    });
    // deepnet-checkboxes in mockup Engine -> echte toggles
    var pe=document.querySelector('.cbx'); // eerste = poort entries (best effort)
  }

  function tick(){ try{ mirrorText(); mirrorPanels(); }catch(e){} }
  function init(){
    moveBlocks(); wireButtons(); wrapCoinFns();
    indexPanels(); tick();
    setInterval(tick,1000);
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init);
  else init();
})();
