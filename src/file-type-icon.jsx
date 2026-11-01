import React from 'react';
import { AppIcon } from './app-icon.jsx';
import { fileTypeIcon } from './file-type-icon.js';
export function FileTypeIcon({ extension, directory = false, size = 20 }) {
  return <span className="file-type-icon" data-file-icon={fileTypeIcon(extension, directory)} aria-hidden="true"><AppIcon name={fileTypeIcon(extension, directory)} size={size}/></span>;
}
