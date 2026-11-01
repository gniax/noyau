import React from "react";
import { AppIcon } from "./app-icon.jsx";
import { tr } from "./i18n.js";

export function TodoCommandMenu({ sort, tools, folderActions }) {
  return <details className="todo-command-more">
    <summary><AppIcon name="settings" size={16}/>{tr("Options")}</summary>
    <div className="todo-command-panel">{sort}<div className="todo-command-tools">{tools}</div>{folderActions && <div className="todo-folder-actions">{folderActions}</div>}</div>
  </details>;
}
