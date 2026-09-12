// SPDX-License-Identifier: GPL-3.0-or-later
// providers/copilot.js - Copilot (copilot.microsoft.com) provider.
const ZSProvider = (() => {
  "use strict";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let diag = () => {};
  const S = {
    chatItem: 'div.group\\/ai-message-item, div[class*="ai-message"], div[data-testid*="message"], div[data-message-id], article, [role="article"]',
    input: 'textarea[data-testid="composer-input"], textarea[placeholder*="Message"], textarea[data-testid*="composer-input"], textarea',
    sendBtn: 'button[data-testid="submit-button"], button[aria-label="Submit message"], button[aria-label*="Submit"], button[type="submit"]',
    stopBtn: 'button[aria-label*="Stop"], button[data-testid*="stop"]',
    errorSurfaces: '[role="alert"],[class*="toast"],[class*="error"]',
    reasoning: '[class*="thinking"],[data-testid*="reasoning"]',
  };
  const RE = {
    contextLimit: new RegExp(["conversation.{0,20}(too long)","context.{0,20}(limit|exceeded)","token.{0,10}limit"].join("|"),"i"),
    tooLong: /conversation .{0,20}(too long)/i,
    busy: /server is busy|try again later|rate limit/i,
  };
  const timings = { GEN_IDLE_MS: 1500, REASON_IDLE_MS: 12000, WARMUP_MS: 45000, REASON_NOREPLY_MS: 90000, STABLE_MS: 9000, RESPONSE_TIMEOUT_MS: 300000 };
  const allItems = () => {
    let items=[...document.querySelectorAll(S.chatItem)].filter(e=> !e.closest('#zs-root') && (e.textContent||'').trim().length>5);
    if(items.length===0){
      items=[...document.querySelectorAll('main [data-message-id], main [role="article"], main article')].filter(e=> !e.closest('#zs-root') && (e.textContent||'').trim().length>20);
    }
    items = items.filter((e,i,arr)=> !arr.some(o=> o!==e && o.contains(e)));
    return items;
  };
  const isAssistantItem = (it) => !!it && (it.matches('[data-author="bot"], [data-testid*="assistant"], [data-message-author-role="assistant"], div.group\\/ai-message-item, div[class*="ai-message"]')|| !!it.querySelector('[data-author="bot"], [class*="assistant"], [data-message-author-role="assistant"]') || it.classList.contains('group/ai-message-item') || /ai-message/i.test(it.className));
  const isUserItem = (it) => !!it && !isAssistantItem(it);
  function textWithout(root, ex){ if(!root) return ""; const c=root.cloneNode(true); c.querySelectorAll('.zs-chip'+(ex?','+ex:'')+', [data-testid*="thinking"], .thinking').forEach(n=>n.remove()); return c.textContent||""; }
  function itemText(it){ if(!it) return ""; return textWithout(it); }
  function classifyText(it,ex){ if(!it) return ""; return textWithout(it, ex); }
  const assistantItems = () => allItems().filter(isAssistantItem);
  const assistantCount = () => assistantItems().length;
  const userCount = () => allItems().filter(isUserItem).length;
  const lastAssistant = () => { const a=assistantItems(); return a.length?a[a.length-1]:null; };
  const _idMap=new WeakMap(); let _seq=0; function lastAssistantId(){ const it=lastAssistant(); if(!it) return null; let id=_idMap.get(it); if(!id){id=++_seq; _idMap.set(it,id);} return id; }
  const chatIsEmpty=()=> allItems().length===0;
  const isReallyVisible = (el) => {
    if(!el || el.closest('#zs-root')) return false;
    if(el.offsetParent===null) return false;
    if(el.getAttribute('aria-hidden')==='true') return false;
    const st=getComputedStyle(el);
    if(st.visibility==='hidden' || st.display==='none' || st.opacity==='0') return false;
    const r=el.getBoundingClientRect();
    return r.width>10 && r.height>5;
  };
  const getEditor=()=>{
    const all=[...document.querySelectorAll(S.input)].filter(isReallyVisible);
    if(!all.length){
      const cand=[...document.querySelectorAll('textarea')].filter(e=> !e.closest('#zs-root') && e.getAttribute('data-testid')==='composer-input');
      if(cand.length) return cand[0];
      return document.querySelector('textarea[data-testid="composer-input"]') || document.querySelector('textarea') || null;
    }
    const main=all.find(e=>e.getAttribute('data-testid')==='composer-input');
    if(main) return main;
    return all.find(e=>e.tagName==='TEXTAREA')||all[0]||null;
  };
  const editorText=()=>{ const e=getEditor(); if(!e) return ""; return e.value!=null?e.value:e.textContent||""; };
  let _locked=false; function setInputLock(on){ _locked=on; const e=getEditor(); if(!e) return; if(on) e.setAttribute('readonly',''); else e.removeAttribute('readonly'); }
  const composerFrame=()=> { const e=getEditor(); return e?e.parentElement:null; };
  function barMount(){ const e=getEditor(); if(!e) return null; let box=e.parentElement; while(box && box!==document.body){ if(box.contains(e)) break; box=box.parentElement; } if(!box) box=e.parentElement; let before=box.firstElementChild; if(before&&before.id==='zs-bar') before=before.nextElementSibling; return {parent:box, before, inside:true}; }
  function isStopBtn(b){ if(!b) return false; return /stop/i.test(b.getAttribute('aria-label')||'')|| /stop/i.test(b.getAttribute('data-testid')||'') || !!b.querySelector('rect'); }
  let _max=-1,_at=0,_item=null; function sample(){ const it=lastAssistant(); const len=(it?it.textContent.length:0); const now=Date.now(); if(it!==_item||len<_max-400){_item=it;_max=len;_at=now;return;} if(len>_max){_max=len;_at=now;} }
  const grewWithin=(ms)=> _max>1 && Date.now()-_at<ms;
  let _stopSince=0;
  function isGenerating(){
    sample();
    const hasStop=!!document.querySelector('button[aria-label*="Stop"]') || (!!document.querySelector(S.stopBtn) && isStopBtn(document.querySelector(S.stopBtn)));
    const now=Date.now();
    if(hasStop){
      if(!_stopSince) _stopSince=now;
      if(grewWithin(timings.GEN_IDLE_MS) || now - _stopSince < 2000) return true;
      if(now - _stopSince > 10000) { _stopSince=0; return grewWithin(timings.GEN_IDLE_MS); }
      return grewWithin(timings.GEN_IDLE_MS);
    }
    _stopSince=0;
    return grewWithin(timings.GEN_IDLE_MS);
  }
  const isBusyNow=isGenerating; const isHardGenerating=()=> !!document.querySelector(S.stopBtn) && isStopBtn(document.querySelector(S.stopBtn));
  function snapshot(){ try{ const it=lastAssistant(); return {rp: it?(it.textContent||'').length:0}; }catch{ return {}; } }
  function findContinueBtn(){ for(const b of document.querySelectorAll('button')){ if(b.offsetParent===null) continue; if(/continue/i.test((b.innerText||'').trim())) return b; } return null; }
  const clickContinueBtn=()=>{ const b=findContinueBtn(); if(!b) return false; try{b.click(); return true;}catch{return false;} };
  function readAssistant(){ const it=lastAssistant(); if(!it) return {present:false, reply:"",thinking:"",item:null}; const t=textWithout(it).trim(); return {present:true, reply:t, thinking:"", item:it}; }
  async function waitFor(p,t){ const t0=Date.now(); while(Date.now()-t0<t){ if(p()) return true; await sleep(120);} return false; }
  function setTextareaValue(el,v){
    const proto=window.HTMLTextAreaElement&&window.HTMLTextAreaElement.prototype;
    const setter=proto&&Object.getOwnPropertyDescriptor(proto,'value');
    try{
      if(setter&&setter.set) setter.set.call(el,v); else el.value=v;
      el.dispatchEvent(new Event('input',{bubbles:true}));
      el.dispatchEvent(new Event('change',{bubbles:true}));
      return true;
    }catch{ return false; }
  }
  const SEND_MAX=10240;
  function truncateForSend(t){
    if(!t || t.length<=SEND_MAX) return t;
    const half=Math.floor(SEND_MAX/2);
    return t.slice(0,half) + t.slice(t.length-half);
  }
  async function typeAndSend(text,images){
    text=truncateForSend(text);
    const ed=getEditor(); if(!ed) throw new Error('Copilot input not found');
    ed.focus();
    let ok=false;
    if(ed.tagName==='TEXTAREA'){
      ok=setTextareaValue(ed,text);
      await sleep(150);
      if(!ok || editorText().trim().length < Math.min(text.length*0.8, 100)){
        try{ ed.value=text; ed.dispatchEvent(new Event('input',{bubbles:true})); ok=true; }catch{}
        await sleep(150);
      }
    } else {
      try{ document.execCommand('selectAll',false,null); }catch{}
      try{ ok=document.execCommand('insertText',false,text); }catch{}
      await sleep(150);
      if(!ok || editorText().trim().length < Math.min(text.length*0.6, 80)){
        try{ ed.textContent=text; ed.dispatchEvent(new InputEvent('input',{bubbles:true, data:text, inputType:'insertText'})); ok=true; }catch{}
        await sleep(150);
      }
    }
    await sleep(200);
    const hasText = () => editorText().trim().length>0;
    await waitFor(hasText, 1000);
    try{
      const t=document.querySelector('textarea[data-testid="composer-input"]')||ed;
      t.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13, which:13, bubbles:true, cancelable:true}));
      t.dispatchEvent(new KeyboardEvent('keypress',{key:'Enter',code:'Enter',keyCode:13, which:13, bubbles:true, cancelable:true}));
      t.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',code:'Enter',keyCode:13, which:13, bubbles:true, cancelable:true}));
    }catch{}
    await sleep(300);
    if(hasText()){
      const b=document.querySelector(S.sendBtn);
      if(b && b.offsetParent!==null){
        try{ b.click(); }catch{}
      }
    }
  }
  const stopGeneration=()=>{ const b=document.querySelector(S.stopBtn); if(b && isStopBtn(b)) try{b.click();}catch{} };
  function scanError(){ try{ for(const el of document.querySelectorAll(S.errorSurfaces)){ if(el.offsetParent===null) continue; const t=(el.innerText||'').trim(); if(t.length>8&&t.length<600&&RE.contextLimit.test(t)) return t.slice(0,240); } }catch{} if(!getEditor()) return "Input disappeared"; return null; }
  const isTooLongMsg=(t)=>RE.tooLong.test(t); const isBusyMsg=(t)=>RE.busy.test(t);
  async function attachImages(images){ return false; }
  const clearAttachments=()=>{};
  const conversationKey=()=> (location.pathname === "/" ? "" : location.pathname + location.search);
  function installSendHooks(h){ document.addEventListener("keydown",e=>{ if(e.key!=="Enter"||e.shiftKey) return; const ed=getEditor(); if(!ed||!ed.contains(e.target)) return; if(editorText().trim()==="") return; if(h.isBlocked()) return; if(!h.isStarted()){ if(!chatIsEmpty()) return; h.onBlockedAttempt(); return; } h.onUserMessage(assistantCount()); },true); document.addEventListener("click",e=>{ const b=e.target&&e.target.closest&&e.target.closest('button'); if(!b) return; if(isStopBtn(b)){h.onNativeStop(); return;} if(!b.matches(S.sendBtn)) return; if(h.isBlocked()) return; h.onUserMessage(assistantCount()); },true); }
  function findToolBlockSpot(item,chip){ const P=ZSParse; const hasStart=t=>P.LUA_START_RE.test(t)||t.includes("###mcp_tool###"); const isJson=t=>/\{\s*"(?:command|tool)"\s*:/.test(t); for(const c of [...item.querySelectorAll('pre,code')]){ const txt=c.textContent||""; if(hasStart(txt)||isJson(txt)){ c.classList.add("zs-tool-hide"); return {parent:c.parentElement, ref:c}; } } return null; }
  return { id:"copilot", displayName:"Copilot", get supportsVision(){return false;}, timings, thinkingSel: S.reasoning, init({diag:d}={}){ if(d) diag=d; try{ chrome.storage.local.get("zsStartedSessions", r=>{ const s=r&&r.zsStartedSessions; if(Array.isArray(s)&&s.includes("/")){ const f=s.filter(x=>x!=="/"); chrome.storage.local.set({zsStartedSessions:f}); }}); }catch{} }, allItems, isUserItem, isAssistantItem, itemText, classifyText, assistantCount, userCount, lastAssistant, lastAssistantId, readAssistant, streamLen:(it)=> (it?it.textContent.length:0), snapshot, getEditor, editorText, chatIsEmpty, isFreshChat:()=> chatIsEmpty() && !!getEditor(), composerFrame, barMount, setInputLock, typeAndSend, stopGeneration, isGenerating, isBusyNow, isHardGenerating, genDebug:()=>({gen:isGenerating()}), enforceComposer:()=>({ready:!!getEditor()}), ensureComposerReady:async()=>({ready:!!getEditor()}), turnHalted:()=>false, findContinueBtn, clickContinueBtn, scanError, isTooLongMsg, isBusyMsg, attachImages, clearAttachments, conversationKey, installSendHooks, findToolBlockSpot };
})();
