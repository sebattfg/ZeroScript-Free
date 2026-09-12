// SPDX-License-Identifier: GPL-3.0-or-later
// providers/grok.js - Grok (grok.com) provider.
const ZSProvider = (() => {
  "use strict";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let diag = () => {};
  const S = {
    chatItem: 'div[data-testid="user-message"], div[data-testid*="message"], div[data-message-id], article',
    input: 'div.ProseMirror[contenteditable="true"], div[contenteditable="true"][role="textbox"], div[contenteditable="true"][aria-label*="Grok"], div[contenteditable="true"], textarea',
    sendBtn: 'button[data-testid="chat-submit"], button[aria-label="Submit"], button[type="submit"]',
    stopBtn: 'button[aria-label*="Stop"], button[data-testid*="stop"], button[aria-label*="Stop generating"]',
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
    let items=[...document.querySelectorAll(S.chatItem)].filter(e=> !e.closest('#zs-root') && (e.textContent||'').trim().length>5 && !/What should we explore|Meet Grok Bot|Switch to Build Mode|Type \/ to use/i.test(e.textContent));
    if(items.length===0){
      const fb=[...document.querySelectorAll('main [data-message-id], main [role="article"], main article, div[data-message-id]')].filter(e=> !e.closest('#zs-root') && (e.textContent||'').trim().length>20 && e.children.length<12 && !/What should we explore|Meet Grok Bot|Switch to Build Mode|Starting Up/i.test(e.textContent));
      if(fb.length) items=fb;
    }
    items = items.filter((e,i,arr)=> !arr.some(o=> o!==e && o.contains(e)));
    return items;
  };
  const isUserItem = (it) => {
    if(!it) return false;
    const t=(it.textContent||'');
    if(t.includes('⟦ZS-SYS')) return true;
    if(/^\s*Output of '/.test(t.trim())) return true;
    if(it.matches('[data-testid*="user"], [data-message-author-role="user"]') || it.querySelector('[data-testid*="user"], [data-message-author-role="user"]')) return true;
    return false;
  };
  const isAssistantItem = (it) => !!it && !isUserItem(it) && !it.closest('#zs-root');
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
    return r.width>10 && r.height>10;
  };
  const getEditor=()=>{
    const all=[...document.querySelectorAll(S.input)].filter(isReallyVisible);
    if(!all.length) return document.querySelector('div[contenteditable="true"][role="textbox"]') || document.querySelector('div.ProseMirror') || null;
    const pm=all.find(e=>e.classList.contains('ProseMirror'));
    if(pm) return pm;
    const box=all.find(e=>e.getAttribute('role')==='textbox');
    if(box) return box;
    const ce=all.find(e=>e.isContentEditable);
    if(ce) return ce;
    return all[0]||null;
  };
  const editorText=()=>{ const e=getEditor(); if(!e) return ""; return e.value!=null?e.value:e.textContent||""; };
  let _locked=false;
  function setInputLock(on){
    _locked=on;
    const e=getEditor();
    if(!e) return;
    if(e.tagName==='TEXTAREA'){
      if(on) e.setAttribute('readonly',''); else e.removeAttribute('readonly');
    } else {
      e.setAttribute('contenteditable', on ? 'false' : 'true');
      if(on) e.setAttribute('data-zs-locked','1'); else e.removeAttribute('data-zs-locked');
    }
  }
  const composerFrame=()=> { const e=getEditor(); return e?e.parentElement:null; };
  function barMount(){ const e=getEditor(); if(!e) return null; let box=e.parentElement; while(box && box!==document.body){ if(box.contains(e)) break; box=box.parentElement; } if(!box) box=e.parentElement; let before=box.firstElementChild; if(before&&before.id==='zs-bar') before=before.nextElementSibling; return {parent:box, before, inside:true}; }
  function isStopBtn(b){ if(!b) return false; return /stop/i.test(b.getAttribute('aria-label')||'')|| /stop/i.test(b.getAttribute('data-testid')||'') || !!b.querySelector('rect'); }
  let _max=-1,_at=0,_item=null; function sample(){ const it=lastAssistant(); const len=(it?it.textContent.length:0); const now=Date.now(); if(it!==_item||len<_max-400){_item=it;_max=len;_at=now;return;} if(len>_max){_max=len;_at=now;} }
  const grewWithin=(ms)=> _max>1 && Date.now()-_at<ms;
  let _stopSince=0;
  function isGenerating(){
    sample();
    const hasStop=!!document.querySelector('button[aria-label*="Stop"], button[data-testid*="stop"], button[aria-label="Stop generating"], .animate-spin, [class*="loading"], [class*="animate-pulse"]') || (!!document.querySelector('button[data-testid="chat-submit"]') && /stop/i.test(document.querySelector('button[data-testid="chat-submit"]')?.getAttribute('aria-label')||'')) || (!!document.querySelector(S.stopBtn) && isStopBtn(document.querySelector(S.stopBtn)));
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
  function setTextareaValue(el,v){ if(el.tagName!=='TEXTAREA') return false; const proto=window.HTMLTextAreaElement&&window.HTMLTextAreaElement.prototype; const s=proto&&Object.getOwnPropertyDescriptor(proto,'value'); try{ if(s&&s.set) s.set.call(el,v); else el.value=v; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return true; }catch{ return false; } }
  async function typeAndSend(text,images){
    const ed=getEditor(); if(!ed) throw new Error('Grok input not found');
    if(_locked) ed.setAttribute('contenteditable','true');
    ed.focus();
    let ok=false;
    if(ed.tagName==='TEXTAREA'){
      ok=setTextareaValue(ed,text);
    }
    if(!ok){
      try{ document.execCommand('selectAll',false,null); }catch{}
      const CHUNK=2000;
      let wrote=false;
      for(let i=0;i<text.length;i+=CHUNK){
        const part=text.slice(i,i+CHUNK);
        let done=false;
        try{ done=document.execCommand('insertText',false,part); }catch{}
        if(done) wrote=true;
        if(i+CHUNK < text.length) await sleep(10);
      }
      ok=wrote;
      await sleep(150);
      const cur=(ed.textContent||'').trim();
      if(!ok || cur.length < Math.min(text.length*0.6, 80)){
        try{
          const sel=window.getSelection();
          const range=document.createRange();
          range.selectNodeContents(ed);
          sel.removeAllRanges();
          sel.addRange(range);
          document.execCommand('insertText',false,text);
          ok=true;
        }catch{}
        await sleep(120);
        if((ed.textContent||'').trim().length < Math.min(text.length*0.6, 80)){
          try{
            ed.textContent='';
            const p=document.createElement('p');
            p.textContent=text;
            ed.appendChild(p);
            ed.dispatchEvent(new InputEvent('input',{bubbles:true, data:text, inputType:'insertText'}));
            ok=true;
          }catch{}
          await sleep(120);
        }
      }
    }
    await sleep(200);
    await waitFor(()=>{ const b=document.querySelector(S.sendBtn); return b && !b.disabled && b.getAttribute('aria-disabled')!=='true' && b.offsetParent!==null; },2000);
    const b=document.querySelector(S.sendBtn);
    if(b && !b.disabled && b.getAttribute('aria-disabled')!=='true' && b.offsetParent!==null){
      try{ b.click(); }catch{}
      if(_locked) { await sleep(100); ed.setAttribute('contenteditable','false'); }
      return;
    }
    try{
      const t=ed.isContentEditable?ed:document.querySelector('div[contenteditable="true"][role="textbox"]')||ed;
      t.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,bubbles:true}));
      t.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',code:'Enter',keyCode:13,bubbles:true}));
    }catch{}
    if(_locked) { await sleep(100); try{ ed.setAttribute('contenteditable','false'); }catch{} }
  }
  const stopGeneration=()=>{ const b=document.querySelector(S.stopBtn); if(b && isStopBtn(b)) try{b.click();}catch{} const sb=document.querySelector('button[data-testid="chat-submit"]'); if(sb && /stop/i.test(sb.getAttribute('aria-label')||'')) try{sb.click();}catch{} };
  function scanError(){ try{ for(const el of document.querySelectorAll(S.errorSurfaces)){ if(el.offsetParent===null) continue; const t=(el.innerText||'').trim(); if(t.length>8&&t.length<600&&RE.contextLimit.test(t)) return t.slice(0,240); } }catch{} if(!getEditor()) return "Input disappeared"; return null; }
  const isTooLongMsg=(t)=>RE.tooLong.test(t); const isBusyMsg=(t)=>RE.busy.test(t);
  async function attachImages(images){ return false; }
  const clearAttachments=()=>{};
  const conversationKey=()=> (location.pathname === "/" ? "" : location.pathname + location.search);
  function installSendHooks(h){ document.addEventListener("keydown",e=>{ if(e.key!=="Enter"||e.shiftKey) return; const ed=getEditor(); if(!ed||!ed.contains(e.target)) return; if(editorText().trim()==="") return; if(h.isBlocked()) return; if(!h.isStarted()){ if(!chatIsEmpty()) return; h.onBlockedAttempt(); return; } h.onUserMessage(assistantCount()); },true); document.addEventListener("click",e=>{ const b=e.target&&e.target.closest&&e.target.closest('button'); if(!b) return; if(isStopBtn(b)){h.onNativeStop(); return;} if(!b.matches(S.sendBtn)) return; if(h.isBlocked()) return; h.onUserMessage(assistantCount()); },true); }
  function findToolBlockSpot(item,chip){ const P=ZSParse; const hasStart=t=>P.LUA_START_RE.test(t)||t.includes("###mcp_tool###"); const isJson=t=>/\{\s*"(?:command|tool)"\s*:/.test(t); for(const c of [...item.querySelectorAll('pre,code')]){ const txt=c.textContent||""; if(hasStart(txt)||isJson(txt)){ c.classList.add("zs-tool-hide"); return {parent:c.parentElement, ref:c}; } } return null; }
  return { id:"grok", displayName:"Grok", get supportsVision(){return true;}, timings, thinkingSel: S.reasoning, init({diag:d}={}){ if(d) diag=d; try{ chrome.storage.local.get("zsStartedSessions", r=>{ const s=r&&r.zsStartedSessions; if(Array.isArray(s)&&s.includes("/")){ const f=s.filter(x=>x!=="/"); chrome.storage.local.set({zsStartedSessions:f}); }}); }catch{} }, allItems, isUserItem, isAssistantItem, itemText, classifyText, assistantCount, userCount, lastAssistant, lastAssistantId, readAssistant, streamLen:(it)=> (it?it.textContent.length:0), snapshot, getEditor, editorText, chatIsEmpty, isFreshChat:()=> chatIsEmpty() && !!getEditor(), composerFrame, barMount, setInputLock, typeAndSend, stopGeneration, isGenerating, isBusyNow, isHardGenerating, genDebug:()=>({gen:isGenerating()}), enforceComposer:()=>({ready:!!getEditor()}), ensureComposerReady:async()=>({ready:!!getEditor()}), turnHalted:()=>false, findContinueBtn, clickContinueBtn, scanError, isTooLongMsg, isBusyMsg, attachImages, clearAttachments, conversationKey, installSendHooks, findToolBlockSpot };
})();
