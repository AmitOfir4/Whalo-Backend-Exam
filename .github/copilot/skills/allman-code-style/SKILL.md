# Allman Brace Style — Code Generation Skill

**BLOCKING REQUIREMENT**: Every time you write or suggest new TypeScript/JavaScript code in this project, you MUST apply Allman brace style. No exceptions.

---

## Rule: Opening braces always go on their own new line.

This applies universally to:

- Functions and methods (including arrow-style callbacks that use blocks)
- `if`, `else if`, `else`
- `for`, `while`, `do...while`
- Classes
- `try`, `catch`, `finally`
- `switch`

---

## if / else if / else

**Always place the opening brace on a new line — even for single-statement or single-return bodies.**

```typescript
if (x === 2)
{
  return;
}

if (condition)
{
  doSomething();
}
else if (otherCondition)
{
  doOther();
}
else
{
  fallback();
}
```

**Never write:**
```typescript
if (x === 2) { return; }     // ❌
if (x === 2) {               // ❌
  return;
}
```

---

## Loops

```typescript
while (x === 2)
{
  x++;
}

for (let x = 1; x < y; x++)
{
  process(x);
}

do
{
  x++;
} while (x < 10);
```

---

## Functions and Methods

```typescript
export async function submitScore(req: Request, res: Response, next: NextFunction): Promise<void>
{
  const { playerId, score } = req.body;
}

async function fetchPlayer(id: string): Promise<Player>
{
  return await Player.findOne({ id });
}

function formatScore(score: number): string
{
  return score.toFixed(2);
}
```

---

## Classes

```typescript
export class ScoreService
{
  private redis: Redis;

  constructor(redis: Redis)
  {
    this.redis = redis;
  }

  async getTop10(): Promise<Score[]>
  {
    return [];
  }
}
```

---

## try / catch / finally

```typescript
try
{
  await doSomething();
}
catch (error)
{
  next(error);
}
finally
{
  cleanup();
}
```

---

## switch / case

```typescript
switch (event)
{
  case 'score.submitted':
  {
    handleScore();
    break;
  }
  default:
  {
    break;
  }
}
```

---

## Summary Checklist

Before outputting any code block, verify:

1. Every `{` that opens a block sits on its own new line
2. No inline single-line blocks: `if (x) { return; }` is **forbidden**
3. `else`, `else if`, `catch`, `finally` each start on a new line after the closing `}` of the previous block
4. All functions — sync, async, exported, private — follow the same rule
5. All loops — `for`, `while`, `do...while` — follow the same rule
