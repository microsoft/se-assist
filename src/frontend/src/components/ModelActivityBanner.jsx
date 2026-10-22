import { useEffect, useMemo, useState } from 'react';
import { Spinner } from '@fluentui/react-components';
import { ClockRegular, WarningRegular } from '@fluentui/react-icons';
import { modelActivityStatus, onModelActivity } from '../electronBridge';

const IDLE = { phase: 'idle', running: 0, queued: 0, cooldownUntil: null, requests: [] };

export default function ModelActivityBanner() {
  const [activity, setActivity] = useState(IDLE);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    let mounted = true;
    modelActivityStatus().then(value => {
      if (mounted && value) setActivity(value);
    }).catch(error => {
      if (mounted) setActivity({
        ...IDLE,
        phase: 'error',
        error: error?.message || 'Could not read AI request status.',
      });
    });
    const unsubscribe = onModelActivity(value => {
      if (value) setActivity(value);
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!activity.cooldownUntil) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [activity.cooldownUntil]);

  const message = useMemo(() => {
    const active = activity.requests?.find(request => request.state === 'running');
    if (activity.phase === 'error') return `AI request status unavailable — ${activity.error}`;
    if (activity.phase === 'cooldown') {
      const seconds = Math.max(0, Math.ceil((activity.cooldownUntil - Date.now()) / 1000));
      return activity.queued
        ? `AI provider cooldown — ${activity.queued} queued request${activity.queued === 1 ? ' resumes' : 's resume'} in ${seconds}s`
        : `AI provider cooldown — new requests available in ${seconds}s`;
    }
    if (activity.running) {
      const waiting = activity.queued ? ` · ${activity.queued} queued` : '';
      return `${active?.label || 'AI request'} running${active?.model ? ` on ${active.model}` : ''}${waiting}`;
    }
    return `${activity.queued} AI request${activity.queued === 1 ? '' : 's'} queued`;
  }, [activity, now]);

  if (!activity || activity.phase === 'idle') return null;

  return (
    <div className={`model-activity-banner ${activity.phase}`} role="status" aria-live="polite">
      {activity.phase === 'error'
        ? <WarningRegular />
        : activity.phase === 'cooldown'
          ? <ClockRegular />
          : <Spinner size="tiny" />}
      <span>{message}</span>
    </div>
  );
}
