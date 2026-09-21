import { type TypedDocumentNode, gql } from '@apollo/client';
import { describe, expect, it, vi } from 'vitest';
import { buildMocks } from '../mockSchema.js';
import { schema } from '../test/schema.js';
import type { BuildMocksOptions } from '../types.js';
import {
  type MockClientParameter,
  graphListStories,
  graphStories,
  resolveMockClient,
} from './index.js';

interface UserFields {
  id: string;
  name: string;
}

const UsersQuery: TypedDocumentNode<{ users: UserFields[] }, Record<string, never>> = gql`
  query Users {
    users {
      id
      name
    }
  }
`;

/** v3 reports `errors` on the result, v4 a single `error`; read whichever is there. */
const errorMessage = (result: unknown): string => {
  const record = result as {
    error?: { message?: string };
    errors?: readonly { message: string }[];
  };
  if (record.error?.message) return record.error.message;
  return (record.errors ?? []).map((entry) => entry.message).join(', ');
};

const factory = () =>
  vi.fn((options: BuildMocksOptions) =>
    buildMocks(schema, { seed: 7, stableIds: true, ...options }),
  );

const parameterOf = (story: { parameters: Record<string, unknown> }, name = 'graphqlMocks') =>
  story.parameters[name] as MockClientParameter;

/**
 * The shape of Storybook's `StoryObj` where this factory touches it — an open `parameters` bag
 * beside optional everything-else. Mimicked rather than imported: the package must stay free of
 * a Storybook dependency, and the point of the check is that a consumer's own `Story` type
 * absorbs these objects structurally.
 */
interface StoryObjLike {
  args?: Record<string, unknown>;
  parameters?: { [name: string]: unknown };
  render?: () => unknown;
}

describe('graphStories', () => {
  it('names one state per member', () => {
    const stories = graphStories();
    expect(parameterOf(stories.Default)).toEqual({ state: 'default' });
    expect(parameterOf(stories.Loading)).toEqual({ state: 'loading' });
    expect(parameterOf(stories.Errored)).toEqual({ state: 'errored' });
  });

  it('carries the base through every member', () => {
    const graph: MockClientParameter = {
      overrides: [{ match: 'Todos', errors: 'nope' }],
      target: 'Users',
      build: { count: 2 },
      delay: 5,
    };
    const stories = graphStories({ graph });

    for (const member of [stories.Default, stories.Loading, stories.Errored]) {
      expect(parameterOf(member)).toMatchObject({
        overrides: graph.overrides,
        target: 'Users',
        build: { count: 2 },
        delay: 5,
      });
    }
    // The base is copied, not held: a set must not be able to rewrite the fixture it was given.
    expect(graph.state).toBeUndefined();
  });

  it('pins each member to its own state, whatever state the base named', () => {
    const stories = graphStories({ graph: 'loading' });
    expect(parameterOf(stories.Default).state).toBe('default');
    expect(parameterOf(stories.Errored).state).toBe('errored');
  });

  it('writes the parameter the decorator was configured to read', () => {
    const stories = graphStories({ parameterName: 'mocks' });
    expect(parameterOf(stories.Loading, 'mocks')).toEqual({ state: 'loading' });
    expect(stories.Loading.parameters.graphqlMocks).toBeUndefined();
  });

  it('produces stories a Storybook Story type accepts', () => {
    const stories = graphStories();
    const Default: StoryObjLike = stories.Default;
    // A meta that leaves required args unset makes `args` the story's job; spreading is how the
    // set still supplies the parameter.
    const Loading: StoryObjLike = { ...stories.Loading, args: { id: '1' } };

    expect(Default.parameters?.graphqlMocks).toEqual({ state: 'default' });
    expect(Loading.args).toEqual({ id: '1' });
  });
});

describe('graphListStories', () => {
  it('adds the two QA members', () => {
    const stories = graphListStories();
    expect(parameterOf(stories.NoResults)).toEqual({ state: 'default', qa: 'emptyLists' });
    expect(parameterOf(stories.LongNames)).toEqual({ state: 'default', qa: 'longText' });
  });

  it('keeps the base build options under the QA preset', () => {
    const stories = graphListStories({ graph: { build: { count: 2 }, target: 'Users' } });
    expect(parameterOf(stories.NoResults)).toEqual({
      state: 'default',
      target: 'Users',
      build: { count: 2 },
      qa: 'emptyLists',
    });
  });

  it('keeps the QA members when an override answers with an error rather than rows', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stories = graphListStories({
      graph: { overrides: [{ match: 'Todos', errors: 'nope' }] },
    });

    // The type keeps NoResults here too: `errors` leaves the graph answering the list.
    expect(parameterOf(stories.NoResults).qa).toBe('emptyLists');
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('omits the QA members when an override supplies rows, and says why', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stories = graphListStories({
      graph: { overrides: [{ match: 'Users', data: { users: [{ id: 'fixture' }] } }] },
    });

    expect(Object.keys(stories)).toEqual(['Default', 'Loading', 'Errored']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('NoResults'));
    warn.mockRestore();
  });
});

describe('the members resolve to the client they name', () => {
  it('renders rows, an error and an empty list from one set', async () => {
    const build = factory();
    const stories = graphListStories({ graph: { build: { count: 3 } } });

    const rows = await resolveMockClient(build, parameterOf(stories.Default)).query({
      query: UsersQuery,
    });
    expect(rows.data?.users.length).toBeGreaterThan(0);

    const errored = await resolveMockClient(build, parameterOf(stories.Errored)).query({
      query: UsersQuery,
    });
    expect(errorMessage(errored)).toContain('scenario error');

    // The whole point of the QA member: it empties the list rather than aliasing Default.
    const empty = await resolveMockClient(build, parameterOf(stories.NoResults)).query({
      query: UsersQuery,
    });
    expect(empty.data?.users).toEqual([]);
    expect(build).toHaveBeenCalledWith({ count: 3, qa: 'emptyLists' });
  });

  it('keeps the base fixture through the loading member', async () => {
    const stories = graphStories({
      graph: { overrides: [{ match: 'Users', data: { users: [{ id: 'fixture', name: 'F' }] } }] },
    });
    const graph = buildMocks(schema, { seed: 7, stableIds: true });

    const rows = await resolveMockClient(graph, parameterOf(stories.Default)).query({
      query: UsersQuery,
    });
    expect(rows.data?.users[0]?.id).toBe('fixture');

    // `'loading'` written by hand here would have dropped the fixture; the set keeps it, so the
    // loading story is the same screen mid-flight.
    expect(parameterOf(stories.Loading)).toMatchObject({
      state: 'loading',
      overrides: [{ match: 'Users' }],
    });
  });
});
