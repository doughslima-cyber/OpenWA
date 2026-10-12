// OpenMsg (docs/32 F3): the dashboard branches on `Session.engine`, and `check:contract-shapes` leaves the
// dashboard `Session` pair out by design. This file pins that one field on both sides: the contract half
// runs under `npm test`, the type half compiles under `npm run typecheck` (tsconfig.test.json).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Session } from './api.ts';

const fixed: Omit<Session, 'engine'> = {
  id: 's1',
  name: 'session-1',
  status: 'ready',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

// A required string: reading it never yields undefined or null.
const engineRead: string = ({ ...fixed, engine: 'baileys' } as Session).engine;
// @ts-expect-error the API never sends a null engine
const engineNull: Session = { ...fixed, engine: null };
// @ts-expect-error the API always sends an engine
const engineAbsent: Session = { ...fixed };

test('C53 the dashboard Session.engine is a required string, matching SessionResponseDto.engine in openapi.json', () => {
  const contract = JSON.parse(
    readFileSync(fileURLToPath(new URL('../../../openapi.json', import.meta.url)), 'utf8'),
  ) as {
    components: {
      schemas: {
        SessionResponseDto: { required?: string[]; properties: { engine?: { type?: string; nullable?: boolean } } };
      };
    };
  };
  const dto = contract.components.schemas.SessionResponseDto;
  assert.equal(dto.properties.engine?.type, 'string');
  assert.notEqual(dto.properties.engine?.nullable, true);
  assert.ok(dto.required?.includes('engine'), 'SessionResponseDto.required lists engine');

  // The type half is checked by the compiler; these keep the probes referenced.
  assert.equal(engineRead, 'baileys');
  assert.equal(engineNull.engine, null);
  assert.equal('engine' in engineAbsent, false);
});
