import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AppIcon } from './app-icon.jsx';
import { tr } from './i18n.js';
export function TodoCardMenu({ children }) {
 const button=useRef(null), panel=useRef(null); const [open,setOpen]=useState(false); const [position,setPosition]=useState(null);
 useEffect(()=>{
  if(!open)return;
  const update=()=>{const rect=button.current?.getBoundingClientRect();if(!rect)return;const width=Math.min(240,window.innerWidth-16);const height=Math.min(panel.current?.offsetHeight || 300,window.innerHeight-16);const below=window.innerHeight-rect.bottom;const top=below>=height || below>=rect.top ? Math.min(rect.bottom+5,window.innerHeight-height-8) : Math.max(8,rect.top-height-5);setPosition({left:Math.max(8,Math.min(rect.right-width,window.innerWidth-width-8)),top:Math.max(8,top),width});};
  const outside=(event)=>{if(!button.current?.contains(event.target)&&!panel.current?.contains(event.target))setOpen(false);};
  const key=(event)=>{if(event.key==='Escape'){setOpen(false);button.current?.focus();}};
  update();window.addEventListener('resize',update);window.addEventListener('scroll',update,true);document.addEventListener('pointerdown',outside);document.addEventListener('keydown',key);return()=>{window.removeEventListener('resize',update);window.removeEventListener('scroll',update,true);document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',key);};
 },[open]);
 return <div className="todo-card-menu"><button ref={button} type="button" className="todo-card-menu-trigger" aria-label={tr('Actions sur la tâche')} title={tr('Actions sur la tâche')} aria-expanded={open} onClick={(event)=>{event.stopPropagation();setOpen(v=>!v);}}><AppIcon name="more" size={15}/></button>{open && createPortal(<div ref={panel} className="todo-card-menu-panel todo-card-menu-floating" style={position || {visibility:'hidden'}} onClick={(event)=>{event.stopPropagation();if(event.target.closest('button'))setOpen(false);}} onChange={(event)=>{event.stopPropagation();if(event.target.tagName==='SELECT')setOpen(false);}}>{children}</div>,document.body)}</div>;
}
