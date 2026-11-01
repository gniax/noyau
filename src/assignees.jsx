import React from "react";
import { tr } from "./i18n.js";

// Accounts come from the instance, never from names written in the code.
let accounts = [];

export function setAssigneeProfiles(profiles) { accounts = Array.isArray(profiles) ? profiles : []; }
export function primaryAssigneeId() { return accounts.find((profile) => profile.primary)?.id || accounts[0]?.id || "main"; }

export function resolveAssignee(todo) {
  if (!todo) return primaryAssigneeId();
  if (todo.assignee === "all" || todo.assignee === "both" || (todo.shared && !todo.assignee)) return "all";
  const known = (id) => accounts.some((profile) => profile.id === id);
  if (known(todo.assignee)) return todo.assignee;
  if (known(todo.ownerProfileId)) return todo.ownerProfileId;
  return primaryAssigneeId();
}

export function AssigneeOptions() {
  return <>
    {accounts.map((profile) => <option value={profile.id} key={profile.id}>{profile.name}</option>)}
    {accounts.length > 1 && <option value="all">{tr("Tout le monde")}</option>}
  </>;
}
