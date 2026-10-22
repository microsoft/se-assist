import { useEffect, useRef, useState } from 'react';
import { Button, Spinner, Textarea } from '@fluentui/react-components';
import { ChatSparkleRegular, DismissRegular, SendRegular } from '@fluentui/react-icons';
import { assistantChat, getAuthStatus, inElectron } from '../electronBridge';

const SUGGESTIONS = [
  'Which of my milestones are most pressing?',
  "What's top of mind for my customers right now?",
  'Which customers have unanswered questions or open action items?',
];

const WELCOME = {
  role: 'assistant',
  content:
    "Hi! I'm your SE Assist copilot. I can look across the milestones you're on the deal team for and tell you which are most pressing (due dates, blocked/at-risk status, ACR), plus what's top of mind for those customers based on your Teams threads. Ask me anything, or pick a starter below.",
};

export default function AssistantBubble() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([WELCOME]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [userName, setUserName] = useState('');
  const scrollRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const auth = await getAuthStatus();
        if (!cancelled) setUserName(auth?.userName || auth?.user || '');
      } catch {
        /* identity falls back to SE_ASSIST_USER_NAME in the main process */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (open && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, open, busy]);

  async function send(question) {
    const text = String(question ?? input).trim();
    if (!text || busy) return;
    setInput('');
    const history = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-6)
      .map((m) => ({ role: m.role, content: m.content }));
    const next = [...messages, { role: 'user', content: text }];
    setMessages(next);
    setBusy(true);
    try {
      const result = await assistantChat({ userName, question: text, history });
      if (result?.ok && result.reply) {
        setMessages([...next, { role: 'assistant', content: result.reply, meta: result.meta }]);
      } else {
        setMessages([...next, { role: 'error', content: result?.error || 'No response from the assistant.' }]);
      }
    } catch (err) {
      setMessages([...next, { role: 'error', content: err?.message || String(err) }]);
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Ask SE Assist Copilot"
        style={fabStyle}
      >
        <ChatSparkleRegular style={{ fontSize: 24 }} />
      </button>
    );
  }

  return (
    <div style={panelStyle}>
      <div style={headerStyle}>
        <ChatSparkleRegular style={{ fontSize: 18 }} />
        <span style={{ flex: 1, fontWeight: 600, fontSize: 14 }}>SE Assist Copilot</span>
        <button type="button" onClick={() => setOpen(false)} title="Close" style={iconBtnStyle}>
          <DismissRegular style={{ fontSize: 16 }} />
        </button>
      </div>

      <div ref={scrollRef} style={bodyStyle}>
        {messages.map((m, i) => (
          <Bubble key={i} role={m.role} content={m.content} />
        ))}
        {busy && (
          <div style={{ ...rowStyle, justifyContent: 'flex-start' }}>
            <div style={{ ...bubbleBase, ...assistantBubble, display: 'flex', alignItems: 'center', gap: 8 }}>
              <Spinner size="tiny" /> <span style={{ color: 'var(--text-secondary)' }}>Thinking…</span>
            </div>
          </div>
        )}
        {messages.length <= 1 && !busy && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
            {SUGGESTIONS.map((s) => (
              <button key={s} type="button" onClick={() => send(s)} style={chipStyle}>
                {s}
              </button>
            ))}
          </div>
        )}
      </div>

      <div style={footerStyle}>
        {!inElectron() && (
          <div style={{ fontSize: 11, color: 'var(--warning-text)', marginBottom: 6 }}>
            Desktop app only — the assistant needs your local data and a configured AI model.
          </div>
        )}
        <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
          <Textarea
            value={input}
            onChange={(_e, d) => setInput(d.value)}
            onKeyDown={onKeyDown}
            placeholder="Ask about your milestones or customers…"
            resize="none"
            appearance="filled-darker"
            style={{ flex: 1, minHeight: 38 }}
            disabled={busy}
          />
          <Button
            appearance="primary"
            icon={<SendRegular />}
            onClick={() => send()}
            disabled={busy || !input.trim()}
            title="Send"
          />
        </div>
      </div>
    </div>
  );
}

function Bubble({ role, content }) {
  if (role === 'user') {
    return (
      <div style={{ ...rowStyle, justifyContent: 'flex-end' }}>
        <div style={{ ...bubbleBase, ...userBubble }}>{content}</div>
      </div>
    );
  }
  const isError = role === 'error';
  return (
    <div style={{ ...rowStyle, justifyContent: 'flex-start' }}>
      <div style={{ ...bubbleBase, ...(isError ? errorBubble : assistantBubble), whiteSpace: 'pre-wrap' }}>
        {content}
      </div>
    </div>
  );
}

/* ── styles ─────────────────────────────────────────────────────────── */

const fabStyle = {
  position: 'fixed', right: 24, bottom: 24, zIndex: 1000,
  width: 56, height: 56, borderRadius: '50%', border: 'none', cursor: 'pointer',
  background: 'linear-gradient(135deg, var(--accent), var(--violet))', color: 'var(--canvas)',
  boxShadow: '0 6px 20px rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center',
};

const panelStyle = {
  position: 'fixed', right: 24, bottom: 24, zIndex: 1000,
  width: 400, maxWidth: 'calc(100vw - 48px)', height: 560, maxHeight: 'calc(100vh - 48px)',
  display: 'flex', flexDirection: 'column',
  background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12,
  boxShadow: '0 12px 40px rgba(0,0,0,0.5)', overflow: 'hidden',
};

const headerStyle = {
  display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px',
  background: 'var(--surface-2)', borderBottom: '1px solid var(--border)', color: 'var(--text)',
};

const iconBtnStyle = {
  background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer',
  display: 'flex', alignItems: 'center', padding: 4, borderRadius: 4,
};

const bodyStyle = {
  flex: 1, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 10,
};

const footerStyle = { padding: 12, borderTop: '1px solid var(--border)', background: 'var(--surface-2)' };

const rowStyle = { display: 'flex', width: '100%' };

const bubbleBase = {
  maxWidth: '85%', padding: '8px 12px', borderRadius: 10, fontSize: 13, lineHeight: 1.5,
  wordBreak: 'break-word',
};

const assistantBubble = { background: 'var(--border)', color: 'var(--text)', borderTopLeftRadius: 2 };
const userBubble = { background: 'var(--accent)', color: 'var(--canvas)', borderTopRightRadius: 2 };
const errorBubble = { background: 'color-mix(in srgb, var(--pink) 7%, transparent)', color: 'var(--pink)', border: '1px solid color-mix(in srgb, var(--pink) 27%, transparent)' };

const chipStyle = {
  textAlign: 'left', background: 'var(--border)', color: 'var(--text)', border: '1px solid var(--border-strong)',
  borderRadius: 8, padding: '8px 10px', fontSize: 12.5, cursor: 'pointer',
};
