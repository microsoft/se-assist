const { test } = require('node:test');
const assert = require('node:assert/strict');

const { cleanVtt, speakersFromClean } = require('../meeting-transcript');

test('cleanVtt turns Teams WebVTT into readable Speaker: text lines', () => {
  const vtt = [
    'WEBVTT',
    '',
    '00:00:03.980 --> 00:00:22.940',
    '<v Pratyush Mishra>Ingress and querying part.</v>',
    '',
    '00:00:23.100 --> 00:00:30.000',
    '<v Pratyush Mishra>I can double check.</v>',
    '',
    '00:00:31.000 --> 00:00:35.000',
    '<v Ni Yao>Yeah, that makes sense.</v>',
    '',
  ].join('\r\n');
  const out = cleanVtt(vtt);
  // Consecutive same-speaker cues merge; timestamps and cue indices are dropped.
  assert.equal(
    out,
    'Pratyush Mishra: Ingress and querying part. I can double check.\nNi Yao: Yeah, that makes sense.',
  );
});

test('cleanVtt strips numeric cue indices and NOTE blocks, keeps speakerless text', () => {
  const vtt = [
    'WEBVTT',
    '',
    'NOTE This is a note',
    '',
    '1',
    '00:00:01.000 --> 00:00:02.000',
    'Plain line without a speaker tag.',
    '',
  ].join('\n');
  assert.equal(cleanVtt(vtt), 'Plain line without a speaker tag.');
});

test('cleanVtt returns non-VTT input trimmed rather than guessing', () => {
  assert.equal(cleanVtt('  just some pasted text  '), 'just some pasted text');
  assert.equal(cleanVtt(''), '');
  assert.equal(cleanVtt(null), '');
});

test('speakersFromClean lists distinct speakers in order', () => {
  const cleaned = 'Ada: hi\nBob: hello\nAda: bye';
  assert.deepEqual(speakersFromClean(cleaned), ['Ada', 'Bob']);
});
