/**
 * Ingredient substitutions.
 *
 * Deterministic and curated on purpose. "I'm out of butter" is exactly the
 * moment a hallucinated ratio does damage, and the answer is spoken while the
 * cook's hands are busy — there is no glanceable source to check it against.
 * The model may phrase the answer; it does not invent the ratio.
 *
 * Anything not in this table returns `null`, and the orchestrator says so
 * plainly rather than guessing.
 */

export type SubstitutionOption = {
  replacement: string;
  ratio: string;
  note: string;
};

export type SubstitutionEntry = {
  ingredient: string;
  aliases: string[];
  options: SubstitutionOption[];
};

export const SUBSTITUTIONS: SubstitutionEntry[] = [
  {
    ingredient: 'butter',
    aliases: ['salted butter', 'unsalted butter'],
    options: [
      { replacement: 'olive oil', ratio: '3 parts oil for 4 parts butter', note: 'Best for sautéing; the sauce will be less creamy.' },
      { replacement: 'ghee', ratio: '1 to 1', note: 'Higher smoke point, slightly nuttier.' },
    ],
  },
  {
    ingredient: 'parmesan',
    aliases: ['parmigiano', 'parmigiano reggiano', 'parmesan cheese'],
    options: [
      { replacement: 'pecorino romano', ratio: '1 to 1', note: 'Saltier, so hold back on added salt.' },
      { replacement: 'grana padano', ratio: '1 to 1', note: 'Milder and usually cheaper.' },
      { replacement: 'nutritional yeast', ratio: 'half the weight', note: 'Dairy-free; adds savouriness, not melt.' },
    ],
  },
  {
    ingredient: 'milk',
    aliases: ['whole milk', 'full fat milk'],
    options: [
      { replacement: 'oat milk', ratio: '1 to 1', note: 'Closest texture among plant milks.' },
      { replacement: 'water plus butter', ratio: '1 cup water with 1 tablespoon butter', note: 'Works in batters, not in drinks.' },
    ],
  },
  {
    ingredient: 'cream',
    aliases: ['heavy cream', 'double cream', 'whipping cream'],
    options: [
      { replacement: 'whole milk plus butter', ratio: '3/4 cup milk with 1/4 cup melted butter per cup', note: 'Will not whip, but enriches a sauce.' },
      { replacement: 'coconut cream', ratio: '1 to 1', note: 'Adds a coconut note; good in curries.' },
    ],
  },
  {
    ingredient: 'egg',
    aliases: ['eggs', 'whole egg'],
    options: [
      { replacement: 'ground flaxseed and water', ratio: '1 tablespoon flax with 3 tablespoons water per egg', note: 'Bind only; will not aerate.' },
      { replacement: 'unsweetened applesauce', ratio: '1/4 cup per egg', note: 'For sweet bakes.' },
    ],
  },
  {
    ingredient: 'garlic',
    aliases: ['fresh garlic', 'garlic cloves'],
    options: [
      { replacement: 'garlic powder', ratio: '1/8 teaspoon per clove', note: 'Add later; it burns faster than fresh.' },
      { replacement: 'shallot', ratio: '1 small shallot per 2 cloves', note: 'Sweeter and milder.' },
    ],
  },
  {
    ingredient: 'chilli flakes',
    aliases: ['red pepper flakes', 'chili flakes', 'crushed red pepper'],
    options: [
      { replacement: 'cayenne pepper', ratio: 'one quarter of the amount', note: 'Much hotter — start low.' },
      { replacement: 'fresh chilli', ratio: '1 small chilli per half teaspoon', note: 'Deseed for less heat.' },
    ],
  },
  {
    ingredient: 'lemon juice',
    aliases: ['fresh lemon juice'],
    options: [
      { replacement: 'white wine vinegar', ratio: 'half the amount', note: 'Sharper; no citrus aroma.' },
      { replacement: 'lime juice', ratio: '1 to 1', note: 'Slightly more floral.' },
    ],
  },
  {
    ingredient: 'buttermilk',
    aliases: [],
    options: [
      { replacement: 'milk with lemon juice', ratio: '1 cup milk with 1 tablespoon lemon juice, rested 10 minutes', note: 'Standard kitchen swap.' },
      { replacement: 'plain yoghurt thinned with water', ratio: '3 parts yoghurt to 1 part water', note: 'Thicker but works in batters.' },
    ],
  },
  {
    ingredient: 'sour cream',
    aliases: [],
    options: [
      { replacement: 'greek yoghurt', ratio: '1 to 1', note: 'Tangier and leaner; do not boil.' },
    ],
  },
  {
    ingredient: 'white wine',
    aliases: ['dry white wine'],
    options: [
      { replacement: 'chicken or vegetable stock with a splash of vinegar', ratio: '1 to 1 stock plus 1 teaspoon vinegar per cup', note: 'Keeps the acidity without alcohol.' },
    ],
  },
  {
    ingredient: 'spaghetti',
    aliases: ['pasta', 'linguine', 'dried pasta'],
    options: [
      { replacement: 'any long dried pasta', ratio: '1 to 1', note: 'Check the packet time; shapes differ by a minute or two.' },
      { replacement: 'short pasta such as penne', ratio: '1 to 1', note: 'Holds chunky sauces better than a butter sauce.' },
    ],
  },
  {
    ingredient: 'parsley',
    aliases: ['flat-leaf parsley', 'fresh parsley'],
    options: [
      { replacement: 'fresh basil', ratio: '1 to 1', note: 'Sweeter; add off the heat.' },
      { replacement: 'dried parsley', ratio: 'one third of the amount', note: 'Add earlier so it rehydrates.' },
    ],
  },
  {
    ingredient: 'sugar',
    aliases: ['white sugar', 'caster sugar', 'granulated sugar'],
    options: [
      { replacement: 'honey', ratio: '3/4 the amount, and reduce other liquid slightly', note: 'Browns faster.' },
      { replacement: 'maple syrup', ratio: '3/4 the amount', note: 'Adds its own flavour.' },
    ],
  },
];

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function findSubstitution(ingredient: string): SubstitutionEntry | null {
  const needle = normalize(ingredient);
  if (!needle) return null;

  for (const entry of SUBSTITUTIONS) {
    if (entry.ingredient === needle || entry.aliases.includes(needle)) return entry;
  }
  // Loose containment, so "salted butter" and "a bit of butter" both land on
  // the butter entry.
  for (const entry of SUBSTITUTIONS) {
    const names = [entry.ingredient, ...entry.aliases];
    if (names.some((name) => needle.includes(name) || name.includes(needle))) return entry;
  }
  return null;
}
