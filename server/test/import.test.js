// The CSV reader used by the import tool (scripts/import.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../scripts/import.js';

test('CSV: headers are normalised; quoted fields keep commas, quotes and line breaks', () => {
  const { keys, records } = parseCsv('﻿Full Name,Phone,Address\r\n"Okafor, Chidi",0803 000 0002,"12 ""A"" Close\nIkeja"\r\n\r\nAmaka,,\n');
  assert.deepEqual(keys, ['full_name', 'phone', 'address']);
  assert.deepEqual(records, [
    { full_name: 'Okafor, Chidi', phone: '0803 000 0002', address: '12 "A" Close\nIkeja' },
    { full_name: 'Amaka', phone: '', address: '' },
  ]);
});

test('CSV: short rows and a missing final newline', () => {
  assert.deepEqual(parseCsv('a,b,c\n1,2').records, [{ a: '1', b: '2', c: '' }]);
  assert.deepEqual(parseCsv('').records, []);
});
