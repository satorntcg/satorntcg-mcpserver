
import fs from 'node:fs';

const cases = JSON.parse(
  fs.readFileSync('evals/tool-selection.json', 'utf8')
);

// Simulated LLM responses.
// These are deliberately hardcoded for our first exercise.
const simulatedResponses = [
  {
    tool: 'get_inventory_summary',
    args: {
      set_name: 'Gothic',
      sort_by: 'market_price',
      limit: 10
    }
  },
  {
    tool: 'get_inventory_summary',
    args: {
      sort_by: 'total_value',
      limit: 5
    }
  },
  {
    tool: 'get_inventory_summary',
    args: {
      sort_by: 'market_price', // Intentional mistake!
      limit: 20
    }
  }
];

let passed = 0;

for (const [index, testCase] of cases.entries()) {
  const actual = simulatedResponses[index];

  const toolCorrect =
    actual.tool === testCase.expected_tool;

  const argsCorrect = Object.entries(
    testCase.expected_args
  ).every(([key, value]) => actual.args[key] === value);

  const success = toolCorrect && argsCorrect;

  if (success) passed++;

  console.log(
    `${success ? 'PASS' : 'FAIL'}: ${testCase.question}`
  );

  if (!success) {
    console.log('  Expected:', testCase.expected_tool,
      testCase.expected_args);
    console.log('  Actual:  ', actual.tool, actual.args);
  }
}

console.log(
  `\nResults: ${passed}/${cases.length} passed ` +
  `(${Math.round((passed / cases.length) * 100)}%)`
);
