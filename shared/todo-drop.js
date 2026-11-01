export function todoDropChange(todo, { folderId, status } = {}) {
 if (!todo) return null;
 if (folderId) return todo.folderId === folderId ? null : { folderId };
 if (status) return (todo.status || (todo.completed ? 'done' : 'todo')) === status ? null : { status };
 return null;
}
