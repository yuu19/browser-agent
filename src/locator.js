export function buildLocator(page, definition) {
  switch (definition.type) {
    case 'role':
      return page.getByRole(definition.role, definition.name === undefined
        ? undefined
        : { name: definition.name, exact: definition.exact });
    case 'label':
      return page.getByLabel(definition.value, { exact: definition.exact });
    case 'text':
      return page.getByText(definition.value, { exact: definition.exact });
    case 'testId':
      return page.getByTestId(definition.value);
    case 'placeholder':
      return page.getByPlaceholder(definition.value, { exact: definition.exact });
    case 'css':
      return page.locator(definition.value);
    default:
      throw new Error(`unsupported locator type: ${definition.type}`);
  }
}

async function visibleLocators(locator) {
  const result = [];
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);
    if (await item.isVisible()) result.push(item);
  }
  return result;
}

function describe(locatorDefinition) {
  if (locatorDefinition.type === 'role') {
    return locatorDefinition.name
      ? `role=${locatorDefinition.role}, name=${JSON.stringify(locatorDefinition.name)}`
      : `role=${locatorDefinition.role}`;
  }
  return `${locatorDefinition.type}=${JSON.stringify(locatorDefinition.value)}`;
}

export async function resolveTarget(page, target, purpose) {
  const all = await visibleLocators(buildLocator(page, target.locator));
  const count = all.length;
  const description = describe(target.locator);

  if (count === 0 && target.required === false) return [];
  if (count === 0) throw new Error(`${purpose} locator did not match a visible element: ${description}`);

  if (target.match.kind === 'one' && count !== 1) {
    throw new Error(`${purpose} locator expected one visible element but matched ${count}: ${description}`);
  }
  if (target.match.kind === 'count' && count !== target.match.count) {
    throw new Error(`${purpose} locator expected ${target.match.count} visible elements but matched ${count}: ${description}`);
  }
  return all;
}

export async function resolveStepTargets(page, step, purpose) {
  if (!step.locator) return [];
  return resolveTarget(page, { locator: step.locator, match: step.match, required: true }, purpose);
}
