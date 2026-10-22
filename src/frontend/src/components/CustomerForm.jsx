import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Button,
  Input,
  Textarea,
  Select,
  Spinner,
  Field,
} from '@fluentui/react-components';
import { SaveRegular, DeleteRegular, ArrowLeftRegular } from '@fluentui/react-icons';
import { useDbQuery, runDb } from '../hooks/useDb';

const SEGMENTS = [
  '',
  'Banking',
  'Insurance',
  'Capital Markets',
  'Payments',
  'Fintech',
  'Wealth Management',
  'Financial Services',
];

const TIERS = ['', 'Standard', 'Premium', 'Strategic'];

const BLANK = {
  name: '',
  industry_segment: '',
  tier: '',
  city: '',
  country: '',
  phone: '',
  website: '',
  revenue: '',
  tpid: '',
  notes: '',
};

export default function CustomerForm() {
  const { id } = useParams();
  const isEdit = Boolean(id);
  const navigate = useNavigate();

  const { data: rows, loading } = useDbQuery(
    isEdit ? 'SELECT * FROM active_customers WHERE id = ?' : 'SELECT 0',
    isEdit ? [id] : [],
    [id]
  );

  const [form, setForm] = useState(BLANK);
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState(null);

  useEffect(() => {
    if (isEdit && rows.length > 0) {
      const c = rows[0];
      setForm({
        name: c.name || '',
        industry_segment: c.industry_segment || '',
        tier: c.tier || '',
        city: c.city || '',
        country: c.country || '',
        phone: c.phone || '',
        website: c.website || '',
        revenue: c.revenue != null ? String(c.revenue) : '',
        tpid: c.tpid || '',
        notes: c.notes || '',
      });
    }
  }, [isEdit, rows]);

  function update(field) {
    return (e, data) => {
      const val = data?.value ?? data?.selectedOptions?.[0] ?? e.target.value;
      setForm((prev) => ({ ...prev, [field]: val }));
    };
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.name.trim()) {
      setFlash({ type: 'error', msg: 'Name is required.' });
      return;
    }

    setSaving(true);
    setFlash(null);
    try {
      const params = [
        form.name.trim(),
        form.industry_segment,
        form.tier,
        form.notes,
        form.city,
        form.country,
        form.phone,
        form.website,
        form.revenue ? Number(form.revenue) : null,
        form.tpid,
      ];

      if (isEdit) {
        await runDb(
          'UPDATE customers SET name=?, industry_segment=?, tier=?, notes=?, city=?, country=?, phone=?, website=?, revenue=?, tpid=? WHERE id=?',
          [...params, id]
        );
      } else {
        await runDb(
          'INSERT INTO customers (name, industry_segment, tier, notes, city, country, phone, website, revenue, tpid) VALUES (?,?,?,?,?,?,?,?,?,?)',
          params
        );
      }
      navigate('/customers');
    } catch (err) {
      setFlash({ type: 'error', msg: `Save failed: ${err.message || err}` });
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!window.confirm(`Delete customer "${form.name}"?`)) return;
    await runDb('DELETE FROM customers WHERE id = ?', [id]);
    navigate('/customers');
  }

  if (loading && isEdit) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 64 }}>
        <Spinner size="large" label="Loading customer…" />
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <h2>{isEdit ? 'Edit Customer' : 'New Customer'}</h2>
        <Button
          appearance="subtle"
          icon={<ArrowLeftRegular />}
          onClick={() => navigate('/customers')}
        >
          Back
        </Button>
      </div>

      {flash && (
        <div className={`flash-message flash-${flash.type}`}>{flash.msg}</div>
      )}

      <form onSubmit={handleSubmit}>
        <div className="form-grid">
          <Field label="Name" required className="full-width">
            <Input value={form.name} onChange={update('name')} placeholder="Customer name" />
          </Field>

          <Field label="Segment">
            <Select value={form.industry_segment} onChange={update('industry_segment')}>
              {SEGMENTS.map((s) => (
                <option key={s} value={s}>
                  {s || '— Select —'}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Tier">
            <Select value={form.tier} onChange={update('tier')}>
              {TIERS.map((t) => (
                <option key={t} value={t}>
                  {t || '— Select —'}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="City">
            <Input value={form.city} onChange={update('city')} placeholder="City" />
          </Field>

          <Field label="Country">
            <Input value={form.country} onChange={update('country')} placeholder="Country" />
          </Field>

          <Field label="Phone">
            <Input value={form.phone} onChange={update('phone')} placeholder="Phone" />
          </Field>

          <Field label="Website">
            <Input value={form.website} onChange={update('website')} placeholder="https://…" />
          </Field>

          <Field label="Revenue">
            <Input
              type="number"
              value={form.revenue}
              onChange={update('revenue')}
              placeholder="Annual revenue"
            />
          </Field>

          <Field label="TPID">
            <Input value={form.tpid} onChange={update('tpid')} placeholder="Top Parent ID" />
          </Field>

          <Field label="Notes" className="full-width">
            <Textarea
              value={form.notes}
              onChange={update('notes')}
              placeholder="Notes…"
              rows={4}
              resize="vertical"
            />
          </Field>
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
          <Button
            appearance="primary"
            icon={<SaveRegular />}
            type="submit"
            disabled={saving}
          >
            {saving ? 'Saving…' : isEdit ? 'Update Customer' : 'Create Customer'}
          </Button>
          {isEdit && (
            <Button
              appearance="subtle"
              icon={<DeleteRegular />}
              onClick={handleDelete}
              style={{ color: 'var(--pink)' }}
            >
              Delete
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}
