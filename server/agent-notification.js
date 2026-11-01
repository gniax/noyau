// Claude sends informational and idle notifications too; those are not questions.
export function claudeNeedsAttention(event) {
 return event?.hook_event_name === 'Notification' && ['permission_prompt', 'elicitation_dialog'].includes(event.notification_type);
}
