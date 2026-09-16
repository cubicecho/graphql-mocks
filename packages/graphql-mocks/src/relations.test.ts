import { describe, expect, it } from 'vitest';
import { UNBOUNDED, relationBounds, resolveRelation } from './relations.js';
import type { RelationSpec, RelationsConfig } from './types.js';

const fn: RelationSpec = ({ pool }) => pool[0];

describe('resolveRelation', () => {
  const config: RelationsConfig = {
    User: { todos: 3, posts: { min: 1, max: 2 }, _default: 0 },
    Post: { comments: 'all' },
    _default: 7,
    _reciprocal: true,
  };

  const cases: [string, string, RelationsConfig | undefined, RelationSpec | undefined][] = [
    ['no config at all', 'User.todos', undefined, undefined],
    ['field entry wins over every default', 'User.todos', config, 3],
    ['a range reads as a size, not a map', 'User.posts', config, { min: 1, max: 2 }],
    ['the type default covers the type other fields', 'User.friends', config, 0],
    ['the top-level default covers other types', 'Comment.author', config, 7],
    ['a type entry without a default falls through', 'Post.author', config, 7],
    ['the flat form applies everywhere', 'User.todos', 2, 2],
    ['the flat form can be explicitly empty', 'User.todos', null, null],
    ['the flat form can be a function', 'User.todos', fn, fn],
  ];

  for (const [name, site, cfg, expected] of cases) {
    it(name, () => {
      const [typeName, fieldName] = site.split('.') as [string, string];
      expect(resolveRelation(typeName, fieldName, cfg)).toEqual(expected);
    });
  }

  it('keeps an explicit none distinct from no opinion', () => {
    const cfg: RelationsConfig = { User: { todos: null } };
    expect(resolveRelation('User', 'todos', cfg)).toBeNull();
    expect(resolveRelation('User', 'posts', cfg)).toBeUndefined();
  });

  it('ignores the reserved keys when looking up a type', () => {
    expect(resolveRelation('_reciprocal', 'todos', { _reciprocal: true })).toBeUndefined();
  });
});

describe('relationBounds', () => {
  const fallback = { min: 1, max: 5 };

  it('falls back for specs that carry no size', () => {
    expect(relationBounds(undefined, fallback)).toEqual(fallback);
    expect(relationBounds(fn, fallback)).toEqual(fallback);
  });

  it('reads null as none', () => {
    expect(relationBounds(null, fallback)).toBeNull();
  });

  it('pins a number to an exact size', () => {
    expect(relationBounds(3, fallback)).toEqual({ min: 3, max: 3 });
    expect(relationBounds(0, fallback)).toEqual({ min: 0, max: 0 });
  });

  it('passes a range through', () => {
    expect(relationBounds({ min: 2, max: 4 }, fallback)).toEqual({ min: 2, max: 4 });
  });

  it('leaves all unbounded for the sampler to clamp', () => {
    expect(relationBounds('all', fallback)).toEqual({ min: UNBOUNDED, max: UNBOUNDED });
  });
});
