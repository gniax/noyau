import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { publicTarget, safePublicFetch } from './public-url-fetch.js';
const execFileAsync = promisify(execFile);
const VIDEO_HOSTS = ['youtube.com', 'youtu.be', 'tiktok.com', 'instagram.com', 'instagr.am'];
export function isRecipeVideo(value) {
  const { hostname } = publicTarget(value);
  return VIDEO_HOSTS.some(host => hostname === host || hostname.endsWith(`.${host}`));
}
export function subtitleText(value) {
  const text = String(value || '').slice(0, 400000);
  try { const data = JSON.parse(text); if (Array.isArray(data.events)) return data.events.flatMap(e => (e.segs || []).map(s => s.utf8 || '')).join(' ').replace(/\s+/g,' ').trim().slice(0,20000); } catch {}
  return text.replace(/^WEBVTT[^\n]*/i,'').replace(/^.*-->.*$/gm,'').replace(/^\d+$/gm,'').replace(/<[^>]*>/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim().slice(0,20000);
}
async function fetchCaption(value, fetchImpl) {
  let url = publicTarget(value);
  for (let n=0;n<4;n++) {
    const response = await fetchImpl(url,{redirect:'manual',signal:AbortSignal.timeout(10000),headers:{accept:'text/vtt,application/json,text/plain'}});
    if ([301,302,303,307,308].includes(response.status)) { if (n===3) return ''; url=publicTarget(new URL(response.headers.get('location'),url).href); continue; }
    if (!response.ok) return ''; const text=await response.text(); if (text.length>400000) return ''; return subtitleText(text);
  }
  return '';
}
export async function readRecipeVideo(value, { run = execFileAsync, fetchImpl = safePublicFetch } = {}) {
  const url=publicTarget(value); if (!isRecipeVideo(url)) throw new Error('Plateforme vidéo non prise en charge.');
  const binary=process.env.NOYAU_YTDLP || 'yt-dlp';
  const {stdout}=await run(binary,['--ignore-config','--no-playlist','--skip-download','--dump-single-json','--no-warnings','--no-progress','--no-cache-dir','--socket-timeout','10','--',url.href],{timeout:45000,maxBuffer:4*1024*1024,env:{...process.env,PATH:`${process.env.HOME || ''}/.local/bin:${process.env.PATH || '/usr/bin:/bin'}`}});
  const info=JSON.parse(stdout); let transcript='';
  const tracks=[info.subtitles,info.automatic_captions].flatMap(group => group ? Object.entries(group).sort(([a],[b]) => Number(!/^fr/i.test(a))-Number(!/^fr/i.test(b))).flatMap(([,items]) => Array.isArray(items) ? items : []) : []);
  const track=tracks.find(item=>item?.url && ['json3','vtt'].includes(item.ext));
  if (track) transcript=await fetchCaption(track.url,fetchImpl).catch(()=> '');
  const description=typeof info.description==='string' ? info.description.slice(0,16000) : '';
  return { title:String(info.title || '').slice(0,200), description, transcript, thumbnail: typeof info.thumbnail === 'string' ? info.thumbnail : '' };
}
