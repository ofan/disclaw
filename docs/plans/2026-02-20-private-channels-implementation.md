# Private Channels + Bot Access Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `private` and `addBot` properties to channel config so disclaw can manage channel visibility and automatically grant the bot access to private channels.

**Architecture:** `private: true` maps to a Discord permission overwrite denying `@everyone` ViewChannel. `addBot: true` adds a permission overwrite granting the bot user ViewChannel + SendMessages. The bot user ID comes from `client.user.id` after login — no manual IDs needed. Changes flow through parser → reconciler → discord provider like existing channel properties (topic, restricted).

**Tech Stack:** TypeScript, discord.js (PermissionFlagsBits, OverwriteType), Zod, node:test

---

### Task 1: Add types for private and addBot

**Files:**
- Modify: `src/types.ts:33-38` (DesiredChannel)
- Modify: `src/types.ts:87-92` (FlatDesiredChannel)
- Modify: `src/types.ts:114-122` (ActualChannel)

**Step 1: Add fields to DesiredChannel, FlatDesiredChannel, and ActualChannel**

In `src/types.ts`, add `private?: boolean` and `addBot?: boolean` to three interfaces:

```typescript
// DesiredChannel (around line 33)
export interface DesiredChannel {
  name: string;
  topic?: string;
  restricted?: boolean;
  private?: boolean;
  addBot?: boolean;
  threads?: string[];
}

// FlatDesiredChannel (around line 87)
export interface FlatDesiredChannel {
  name: string;
  topic?: string;
  restricted?: boolean;
  private?: boolean;
  addBot?: boolean;
  categoryName?: string;
}

// ActualChannel (around line 114)
export interface ActualChannel {
  id: string;
  name: string;
  type: "text";
  topic?: string;
  restricted?: boolean;
  private?: boolean;
  addBot?: boolean;
  categoryId?: string;
  managedBy?: string;
}
```

**Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS (new optional fields don't break anything)

**Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: add private and addBot fields to channel types"
```

---

### Task 2: Update parser schema and validation

**Files:**
- Modify: `src/parser.ts:14-19` (ChannelSchema)
- Modify: `src/parser.ts:59-156` (validateDesiredState)
- Modify: `src/parser.ts:170-234` (flattenDesiredState)
- Test: `src/parser.test.ts`

**Step 1: Write failing tests for parser changes**

Add these tests at the end of the `parseConfig` describe block in `src/parser.test.ts`:

```typescript
it("parses private and addBot on channels", () => {
  const yaml = `
version: 1
managedBy: disclaw
guild: "123"
channels:
  - name: alerts
    private: true
    addBot: true
  - name: general
`;
  const result = parseConfig(yaml);
  const alertsEntry = result.channels[0] as { name: string; private?: boolean; addBot?: boolean };
  assert.equal(alertsEntry.private, true);
  assert.equal(alertsEntry.addBot, true);

  const generalEntry = result.channels[1] as { name: string; private?: boolean; addBot?: boolean };
  assert.equal(generalEntry.private, undefined);
  assert.equal(generalEntry.addBot, undefined);
});

it("warns on addBot without private", () => {
  const yaml = `
version: 1
managedBy: disclaw
guild: "123"
channels:
  - name: general
    addBot: true
`;
  const result = parseConfig(yaml);
  assert.ok(result.warnings);
  assert.ok(result.warnings.some((w) => w.includes("addBot") && w.includes("general")));
});
```

And add this test to the `flattenDesiredState` describe block:

```typescript
it("forwards private and addBot to flat channels", () => {
  const yaml = `
version: 1
managedBy: disclaw
guild: "123"
channels:
  - name: alerts
    private: true
    addBot: true
  - category: Work
    channels:
      - name: dev
        private: true
`;
  const state = parseConfig(yaml);
  const flat = flattenDesiredState(state);

  const alerts = flat.channels.find((c) => c.name === "alerts");
  assert.ok(alerts);
  assert.equal(alerts.private, true);
  assert.equal(alerts.addBot, true);

  const dev = flat.channels.find((c) => c.name === "dev");
  assert.ok(dev);
  assert.equal(dev.private, true);
  assert.equal(dev.addBot, undefined);
});
```

**Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — `private` and `addBot` not in Zod schema yet, so Zod strips them

**Step 3: Update ChannelSchema in parser.ts**

In `src/parser.ts`, update `ChannelSchema` (around line 14):

```typescript
const ChannelSchema = z.object({
  name: z.string(),
  topic: z.string().optional(),
  restricted: z.boolean().optional(),
  private: z.boolean().optional(),
  addBot: z.boolean().optional(),
  threads: z.array(z.string()).optional(),
});
```

**Step 4: Add validation warning for addBot without private**

In `src/parser.ts`, inside `validateDesiredState()`, add warnings for `addBot` without `private`. Add this check in both the category group channel loop and the standalone channel branch.

In the category group channel loop (after the thread validation, around line 95):

```typescript
if (ch.addBot && !ch.private) {
  warnings.push(`Channel "${ch.name}" has addBot without private (bot already has access to public channels)`);
}
```

In the standalone channel branch (after the thread validation, around line 116):

```typescript
if (entry.addBot && !entry.private) {
  warnings.push(`Channel "${entry.name}" has addBot without private (bot already has access to public channels)`);
}
```

**Step 5: Forward private and addBot in flattenDesiredState**

In `src/parser.ts`, update `flattenDesiredState()` to forward the new fields.

In the category group branch (around line 180):

```typescript
channels.push({
  name: ch.name,
  topic: ch.topic,
  restricted: ch.restricted,
  private: ch.private,
  addBot: ch.addBot,
  categoryName: entry.category,
});
```

In the standalone channel branch (around line 193):

```typescript
channels.push({
  name: entry.name,
  topic: entry.topic,
  restricted: entry.restricted,
  private: entry.private,
  addBot: entry.addBot,
});
```

**Step 6: Run tests**

Run: `npm test 2>&1 | tail -20`
Expected: PASS — all tests including new ones

**Step 7: Commit**

```bash
git add src/parser.ts src/parser.test.ts
git commit -m "feat: parse private and addBot in channel schema"
```

---

### Task 3: Update reconciler to diff private and addBot

**Files:**
- Modify: `src/reconciler.ts:62-115` (channel diff logic)
- Test: `src/reconciler.test.ts` (if it exists, otherwise add tests to parser.test.ts)

**Step 1: Check if reconciler tests exist**

Run: `ls src/reconciler.test.ts 2>/dev/null || echo "no test file"`

If no test file exists, create `src/reconciler.test.ts`. If it exists, add to it.

**Step 2: Write failing tests for reconciler**

Create or append to `src/reconciler.test.ts`:

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reconcile } from "./reconciler.ts";
import type { DesiredState, DiscordState, OpenClawState } from "./types.ts";

const emptyOC: OpenClawState = { bindings: [] };

describe("reconcile private/addBot", () => {
  it("creates channel with private and addBot in details", () => {
    const desired: DesiredState = {
      version: 1,
      managedBy: "disclaw",
      guild: "123",
      channels: [{ name: "alerts", private: true, addBot: true }],
    };
    const discord: DiscordState = { categories: [], channels: [], threads: [], pins: [] };

    const result = reconcile(desired, discord, emptyOC);
    const action = result.actions.find((a) => a.name === "alerts");
    assert.ok(action);
    assert.equal(action.type, "create");
    assert.equal((action.details?.after as any)?.private, true);
    assert.equal((action.details?.after as any)?.addBot, true);
  });

  it("detects private change from false to true", () => {
    const desired: DesiredState = {
      version: 1,
      managedBy: "disclaw",
      guild: "123",
      channels: [{ name: "alerts", private: true }],
    };
    const discord: DiscordState = {
      categories: [],
      channels: [{ id: "1", name: "alerts", type: "text" }],
      threads: [],
      pins: [],
    };

    const result = reconcile(desired, discord, emptyOC);
    const action = result.actions.find((a) => a.name === "alerts");
    assert.ok(action);
    assert.equal(action.type, "update");
    assert.equal((action.details?.after as any)?.private, true);
  });

  it("detects addBot change", () => {
    const desired: DesiredState = {
      version: 1,
      managedBy: "disclaw",
      guild: "123",
      channels: [{ name: "alerts", private: true, addBot: true }],
    };
    const discord: DiscordState = {
      categories: [],
      channels: [{ id: "1", name: "alerts", type: "text", private: true }],
      threads: [],
      pins: [],
    };

    const result = reconcile(desired, discord, emptyOC);
    const action = result.actions.find((a) => a.name === "alerts");
    assert.ok(action);
    assert.equal(action.type, "update");
    assert.equal((action.details?.after as any)?.addBot, true);
  });

  it("noop when private and addBot match", () => {
    const desired: DesiredState = {
      version: 1,
      managedBy: "disclaw",
      guild: "123",
      channels: [{ name: "alerts", private: true, addBot: true }],
    };
    const discord: DiscordState = {
      categories: [],
      channels: [{ id: "1", name: "alerts", type: "text", private: true, addBot: true }],
      threads: [],
      pins: [],
    };

    const result = reconcile(desired, discord, emptyOC);
    const action = result.actions.find((a) => a.name === "alerts");
    assert.ok(action);
    assert.equal(action.type, "noop");
  });
});
```

**Step 3: Run tests to verify they fail**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — reconciler doesn't check `private`/`addBot` yet, so changes are missed

**Step 4: Update reconciler channel diff**

In `src/reconciler.ts`, update the channel diff block (around line 65-115).

In the create branch (around line 69), add `private` and `addBot` to `details.after`:

```typescript
actions.push({
  type: "create",
  resourceType: "channel",
  name: ch.name,
  details: {
    after: {
      topic: ch.topic,
      ...(ch.restricted ? { restricted: true } : {}),
      ...(ch.private ? { private: true } : {}),
      ...(ch.addBot ? { addBot: true } : {}),
      ...(ch.categoryName ? { categoryName: ch.categoryName } : {}),
    },
  },
});
```

In the update detection block (around line 86-88), add `privateChanged` and `addBotChanged`:

```typescript
const privateChanged = !!existing.private !== !!ch.private;
const addBotChanged = !!existing.addBot !== !!ch.addBot;

if (topicChanged || categoryChanged || restrictedChanged || privateChanged || addBotChanged) {
```

In the update action's `details.before` (around line 96-98), add:

```typescript
...(existing.private ? { private: true } : {}),
...(existing.addBot ? { addBot: true } : {}),
```

In the update action's `details.after` (around line 100-108), add:

```typescript
...(ch.private ? { private: true } : {}),
...(ch.addBot ? { addBot: true } : {}),
```

**Step 5: Run tests**

Run: `npm test 2>&1 | tail -20`
Expected: PASS

**Step 6: Commit**

```bash
git add src/reconciler.ts src/reconciler.test.ts
git commit -m "feat: reconciler diffs private and addBot changes"
```

---

### Task 4: Update Discord provider fetch to detect private/addBot

**Files:**
- Modify: `src/providers/discord.ts:1-9` (imports)
- Modify: `src/providers/discord.ts:65-124` (fetch method)

**Step 1: Add PermissionFlagsBits and OverwriteType to imports**

In `src/providers/discord.ts`, update the import from discord.js (line 1-8):

```typescript
import {
  Client,
  GatewayIntentBits,
  ChannelType,
  PermissionFlagsBits,
  OverwriteType,
  type Guild,
  type CategoryChannel,
  type TextChannel,
} from "discord.js";
```

**Step 2: Update fetch() to detect permission overwrites**

In `src/providers/discord.ts`, in the `fetch()` method, update the text channel loop (around line 86-95). After building `textCh`, detect `private` and `addBot` from permission overwrites:

```typescript
for (const [, ch] of allChannels) {
  if (ch && ch.type === ChannelType.GuildText) {
    const textCh = ch as TextChannel;

    // Detect private: @everyone denied ViewChannel
    const everyoneOverwrite = textCh.permissionOverwrites.cache.find(
      (ow) => ow.id === textCh.guild.id && ow.type === OverwriteType.Role,
    );
    const isPrivate = everyoneOverwrite?.deny.has(PermissionFlagsBits.ViewChannel) || false;

    // Detect addBot: bot user allowed ViewChannel
    const botUserId = this.client.user?.id;
    const botOverwrite = botUserId
      ? textCh.permissionOverwrites.cache.find(
          (ow) => ow.id === botUserId && ow.type === OverwriteType.Member,
        )
      : undefined;
    const hasAddBot = botOverwrite?.allow.has(PermissionFlagsBits.ViewChannel) || false;

    textChannels.push({
      id: textCh.id,
      name: textCh.name,
      type: "text",
      topic: textCh.topic ?? undefined,
      restricted: textCh.nsfw || undefined,
      private: isPrivate || undefined,
      addBot: hasAddBot || undefined,
      categoryId: textCh.parentId ?? undefined,
    });

    // ... threads and pins fetching remains unchanged
```

**Step 3: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 4: Commit**

```bash
git add src/providers/discord.ts
git commit -m "feat: discord provider detects private/addBot from overwrites"
```

---

### Task 5: Update Discord provider apply to manage overwrites

**Files:**
- Modify: `src/providers/discord.ts:126-241` (apply method)

**Step 1: Add a helper to build permission overwrites array**

Add this private method to `DiscordProvider` class, before the `apply` method:

```typescript
private buildPermissionOverwrites(
  isPrivate?: boolean,
  addBot?: boolean,
): { id: string; deny?: bigint[]; allow?: bigint[]; type: OverwriteType }[] {
  const overwrites: { id: string; deny?: bigint[]; allow?: bigint[]; type: OverwriteType }[] = [];

  if (isPrivate) {
    const guild = this.getGuild();
    overwrites.push({
      id: guild.id, // @everyone role ID === guild ID
      deny: [PermissionFlagsBits.ViewChannel],
      type: OverwriteType.Role,
    });
  }

  if (addBot && this.client.user) {
    overwrites.push({
      id: this.client.user.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
      type: OverwriteType.Member,
    });
  }

  return overwrites;
}
```

**Step 2: Update channel create in apply()**

In the `apply()` method, in the `case "channel"` create branch (around line 166-179), add `permissionOverwrites`:

```typescript
if (action.type === "create") {
  const after = action.details?.after as Record<string, unknown> | undefined;
  const topic = after?.topic as string | undefined;
  const categoryName = after?.categoryName as string | undefined;
  const restricted = after?.restricted as boolean | undefined;
  const isPrivate = after?.private as boolean | undefined;
  const addBot = after?.addBot as boolean | undefined;
  const parentId = categoryName ? categoryMap.get(categoryName) : undefined;
  const permissionOverwrites = this.buildPermissionOverwrites(isPrivate, addBot);
  const created = await guild.channels.create({
    name: action.name,
    type: ChannelType.GuildText,
    parent: parentId,
    topic: topic || undefined,
    nsfw: restricted || undefined,
    permissionOverwrites: permissionOverwrites.length > 0 ? permissionOverwrites : undefined,
  });
  channelMap.set(action.name, created.id);
}
```

**Step 3: Update channel update in apply()**

In the update branch (around line 180-195), add permission overwrite sync:

```typescript
} else if (action.type === "update") {
  const chId = channelMap.get(action.name);
  if (chId) {
    const ch = (await guild.channels.fetch(chId)) as TextChannel;
    const after = action.details?.after as Record<string, unknown> | undefined;
    const topic = after?.topic as string | undefined;
    const categoryName = after?.categoryName as string | undefined;
    const restricted = after?.restricted as boolean | undefined;
    const isPrivate = after?.private as boolean | undefined;
    const addBot = after?.addBot as boolean | undefined;
    const parentId = categoryName ? categoryMap.get(categoryName) : undefined;
    const parentChanged = "categoryName" in (after ?? {});
    const privateChanged = "private" in (after ?? {});
    const addBotChanged = "addBot" in (after ?? {});

    await ch.edit({
      topic: topic || undefined,
      nsfw: restricted ?? false,
      ...(parentChanged ? { parent: parentId ?? null } : {}),
    });

    // Sync permission overwrites if private or addBot changed
    if (privateChanged || addBotChanged) {
      const permissionOverwrites = this.buildPermissionOverwrites(isPrivate, addBot);
      await ch.permissionOverwrites.set(permissionOverwrites);
    }
  }
}
```

**Step 4: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 5: Commit**

```bash
git add src/providers/discord.ts
git commit -m "feat: discord provider applies private/addBot permission overwrites"
```

---

### Task 6: Update import command

**Files:**
- Modify: `src/commands/import.ts:140-170` (import logic)

**Step 1: Forward private and addBot in import**

In `src/commands/import.ts`, update the category child channel import (around line 148-153):

```typescript
const childEntries = childChannels.map((ch) => {
  channelsInUnmanagedCategories.add(ch.id);
  const entry: Record<string, unknown> = { name: ch.name };
  if (ch.topic) entry.topic = ch.topic;
  if (ch.restricted) entry.restricted = true;
  if (ch.private) entry.private = true;
  if (ch.addBot) entry.addBot = true;
  return entry;
});
```

Update the standalone channel import (around line 162-168):

```typescript
if (r.resourceType === "channel" && !channelsInUnmanagedCategories.has(r.id)) {
  const entry: Record<string, unknown> = { name: r.name };
  if (r.topic) entry.topic = r.topic;
  const srcCh = guildState.channels.find((ch) => ch.id === r.id);
  if (srcCh?.restricted) entry.restricted = true;
  if (srcCh?.private) entry.private = true;
  if (srcCh?.addBot) entry.addBot = true;
  channels.add(doc.createNode(entry));
  importedCount++;
}
```

**Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 3: Commit**

```bash
git add src/commands/import.ts
git commit -m "feat: import command captures private and addBot from Discord"
```

---

### Task 7: Update example config and run full test suite

**Files:**
- Modify: `disclaw.example.yaml`

**Step 1: Add private/addBot example to disclaw.example.yaml**

Add an example private channel with addBot to the example config:

```yaml
  - name: alerts
    topic: "Alert notifications"
    private: true
    addBot: true
```

**Step 2: Run full test suite**

Run: `npm test`
Expected: ALL PASS

**Step 3: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 4: Commit**

```bash
git add disclaw.example.yaml
git commit -m "docs: add private/addBot example to disclaw.example.yaml"
```

---

### Task 8: Update CLAUDE.md and SKILL.md

**Files:**
- Modify: `CLAUDE.md`
- Modify: `skills/disclaw/SKILL.md` (if it exists)

**Step 1: Add private/addBot to schema docs in CLAUDE.md**

In the Schema section of `CLAUDE.md`, add a note:

```markdown
- `private: true` on channels denies @everyone ViewChannel (permission overwrite)
- `addBot: true` grants the bot ViewChannel + SendMessages on private channels
```

**Step 2: Update SKILL.md if it exists**

Check `skills/disclaw/SKILL.md` — if it documents channel properties, add `private` and `addBot`.

**Step 3: Commit**

```bash
git add CLAUDE.md skills/disclaw/SKILL.md
git commit -m "docs: document private and addBot channel properties"
```
