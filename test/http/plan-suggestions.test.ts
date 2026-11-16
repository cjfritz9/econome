import { describe, expect, it } from 'vitest';
import { DATE, setup, WEEK } from './harness.ts';

describe('POST /api/weeks/:date/meals/suggestions', () => {
  it("answers with the week's coverage and what's left, from the saved week when there's no draft", async () => {
    const { status, body } = await setup().call('POST', `/weeks/${DATE}/meals/suggestions`);

    expect(status).toBe(200);
    expect(body).toMatchObject({
      week: { id: WEEK },
      people: 1,
      directive: 'directives/general.md',
      coverage: { dinner: { planned: 1, target: 0, leftToPlan: 0, fromHungryroot: 0 } },
    });
  });

  it('counts a draft instead of the saved meals, and refuses a recipe that cannot be planned', async () => {
    const harness = setup();

    const draft = await harness.call('POST', `/weeks/${DATE}/meals/suggestions`, { meals: [] });
    const unknown = await harness.call('POST', `/weeks/${DATE}/meals/suggestions`, { meals: [{ recipeId: 'nope' }] });

    expect(draft.body.coverage).toMatchObject({ dinner: { planned: 0 } });
    expect(unknown.status).toBe(400);
  });
});
