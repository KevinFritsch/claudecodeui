// Kvn: per-project Work dashboard (to-dos, Jira, pull requests), shown as a project-level tab.
export { default as WorkPanel } from '@/modules/work/WorkPanel';
export { useWorkConfig } from '@/modules/work/useWorkConfig';
export type { WorkConfig } from '@/modules/work/api';
export { consumePendingWorkLink } from '@/modules/work/pendingWorkLink';
export { workApi } from '@/modules/work/api';
export { useWorkBadge } from '@/modules/work/useWorkBadge';
