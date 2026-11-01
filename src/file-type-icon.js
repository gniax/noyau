export function fileTypeIcon(ext, directory = false) {
  const type = String(ext || '').toLowerCase();
  if (directory) return 'folder';
  if (['.png','.jpg','.jpeg','.svg','.webp','.gif','.bmp','.ico'].includes(type)) return 'image';
  if (['.mp4','.webm','.mov','.mkv'].includes(type)) return 'video';
  if (['.mp3','.wav','.ogg','.m4a','.aac','.flac'].includes(type)) return 'audio';
  if (['.zip','.tar','.gz','.rar','.7z','.apk','.ipa','.aab'].includes(type)) return 'archive';
  if (['.js','.jsx','.ts','.tsx','.py','.sh','.json','.html','.css','.sql','.rs','.go','.c','.cpp'].includes(type)) return 'code';
  return 'file';
}
