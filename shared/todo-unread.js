export function countedTodoUnread(todo) {
  if (todo?.status === 'done' || todo?.completed === true) return 0;
  return Math.max(0, Number(todo?.unread) || 0);
}
export function totalTodoUnread(todos) { return (todos || []).reduce((sum, todo) => sum + countedTodoUnread(todo), 0); }
