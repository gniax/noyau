import fs from 'node:fs/promises';
import { parseTranscriptLine, classifyUserText } from './agent-map.js';
// Walk backwards, skipping giant tool-output lines, until enough real conversation is found.
export async function readConversationTail(file, assistant, { maxBytes = 128 * 1024 * 1024, chunkBytes = 1024 * 1024, perRole = 20, maxLineBytes = 2 * 1024 * 1024 } = {}) {
 const handle=await fs.open(file,'r');
 try {
  const stat=await handle.stat(); let end=stat.size, scanned=0, suffix=Buffer.from('\n'), dropping=false, users=0, answers=0; const entries=[];
  while(end>0 && scanned<maxBytes && (users<perRole || answers<perRole)) {
   const length=Math.min(chunkBytes,end,maxBytes-scanned);end-=length;scanned+=length;
   const block=Buffer.alloc(length);await handle.read(block,0,length,end);
   let data=Buffer.concat([block,suffix]);suffix=Buffer.alloc(0);
   if(dropping){const cut=data.lastIndexOf(10);if(cut<0)continue;data=data.subarray(0,cut+1);dropping=false;}
   let cursor=data.length;
   while(cursor>0){const nl=data.lastIndexOf(10,cursor-1);if(nl<0)break;const line=data.subarray(nl+1,cursor);cursor=nl;if(!line.length||line.length>maxLineBytes)continue;
    const entry=parseTranscriptLine(line.toString('utf8'),assistant);if(!entry)continue;
    if(entry.role==='user' && classifyUserText(entry.text)) users++; else if(entry.role==='assistant') answers++;
    entries.push(entry);
   }
   suffix=data.subarray(0,cursor);
   if(suffix.length>maxLineBytes){suffix=Buffer.alloc(0);dropping=true;}
  }
  if(end===0 && !dropping && suffix.length){const entry=parseTranscriptLine(suffix.toString('utf8'),assistant);if(entry)entries.push(entry);}
  return entries.reverse();
 } finally { await handle.close(); }
}
