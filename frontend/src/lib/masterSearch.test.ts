import { describe, it, expect } from 'vitest';
import { ApiError } from './api';
import { byIdPath, masterSearchEmptyText } from './masters';

// C40 / S1-D10: a HOD-only account opened Create Requisition, its item search answered
// 403, and the picker said "No item found. Check the item code or name."
describe('what an item or supplier picker says when it lists nothing', () => {
  const refused = new ApiError(403, 'AUTHORIZATION_ERROR', 'You do not have permission to perform this action (item.view).');

  it('names the refusal and the right to ask for, whatever was typed', () => {
    for (const term of ['', 'CBL']) {
      expect(masterSearchEmptyText('item', term, refused))
        .toBe('You cannot search items: your role does not include item.view. Ask your administrator for it.');
      expect(masterSearchEmptyText('supplier', term, refused))
        .toBe('You cannot search suppliers: your role does not include supplier.view. Ask your administrator for it.');
    }
  });

  it('says a failed search failed, with the reason', () => {
    const lost = new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server.');
    expect(masterSearchEmptyText('item', 'CBL', lost)).toBe('Could not search items. Cannot reach the server.');
    expect(masterSearchEmptyText('supplier', '', new ApiError(500, 'SERVER_ERROR', 'Boom.'))).toBe('Could not search suppliers. Boom.');
  });

  it('keeps the old words when the search answered', () => {
    expect(masterSearchEmptyText('item', '', null)).toBe('Type the item code or name to search.');
    expect(masterSearchEmptyText('item', 'ZZZ', null)).toBe('No item found. Check the item code or name.');
    expect(masterSearchEmptyText('supplier', '', undefined)).toBe('Type the supplier name to search.');
    expect(masterSearchEmptyText('supplier', 'ZZZ', undefined)).toBe('No supplier found. Check the name.');
  });
});

// C41: a supplier or item filter that arrives in the address showed as "#10039".
describe('looking up the records a filter names by id', () => {
  it('asks the search endpoint for exactly those ids, once each, in a stable order', () => {
    expect(byIdPath('supplier', ['10039'])).toBe('/suppliers/search?ids=10039&limit=1');
    expect(byIdPath('item', ['55', '7', '55'])).toBe('/items/search?ids=55%2C7&limit=2');
    expect(byIdPath('item', ['7', '55'])).toBe(byIdPath('item', ['55', '7']));
  });

  it('never sends what is not an id', () => {
    expect(byIdPath('item', ['12', 'abc', '', '3; drop'])).toBe('/items/search?ids=12&limit=1');
  });
});
