#!/usr/bin/env node
// Per-socket tickets (S-742): good once, for 30 seconds, for the kind and path they were issued for.
// No daemon: `node --test test/ticket.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearTickets, issueTicket, redeemTicket, TICKET_TTL_MS } from '../src/ticket.ts';

const P = '/api/shells/sh-1/tty';

test('a ticket works once', () => {
  clearTickets();
  const { ticket } = issueTicket('tty', P, true);
  assert.deepEqual(redeemTicket(ticket, 'tty', P), { trusted: true });
  assert.equal(redeemTicket(ticket, 'tty', P), undefined);
});

test('a ticket remembers whether its request was trusted', () => {
  clearTickets();
  const { ticket } = issueTicket('tty', P, false);
  assert.deepEqual(redeemTicket(ticket, 'tty', P), { trusted: false });
});

test('a ticket expires after 30 seconds', () => {
  clearTickets();
  const now = 1_000_000;
  const { ticket, expires } = issueTicket('tty', P, true, now);
  assert.equal(expires, now + TICKET_TTL_MS);
  assert.equal(TICKET_TTL_MS, 30_000);
  assert.equal(redeemTicket(ticket, 'tty', P, expires), undefined);
  const again = issueTicket('tty', P, true, now);
  assert.deepEqual(redeemTicket(again.ticket, 'tty', P, expires - 1), { trusted: true });
});

test('a ticket is refused for another socket kind or path, and is spent by the try', () => {
  clearTickets();
  const { ticket } = issueTicket('tty', P, true);
  assert.equal(redeemTicket(ticket, 'other', P), undefined);
  assert.equal(redeemTicket(ticket, 'tty', P), undefined);
  const b = issueTicket('tty', P, true);
  assert.equal(redeemTicket(b.ticket, 'tty', '/api/shells/sh-2/tty'), undefined);
  assert.equal(redeemTicket(b.ticket, 'tty', P), undefined);
});

test('no ticket, or a made-up one, is refused', () => {
  clearTickets();
  assert.equal(redeemTicket(null, 'tty', P), undefined);
  assert.equal(redeemTicket('', 'tty', P), undefined);
  assert.equal(redeemTicket('made-up', 'tty', P), undefined);
});
