# Private Channels + Bot Access

## Goal

Allow disclaw to manage channel visibility (private/public) and automatically grant the Discord bot access to private channels.

## YAML Schema

Two new optional properties on channels:

```yaml
channels:
  - name: alerts
    private: true    # deny @everyone ViewChannel
    addBot: true     # grant the bot ViewChannel + SendMessages

  - name: general    # public by default
```

- `private: true` denies `@everyone` the `ViewChannel` permission via a permission overwrite
- `addBot: true` adds a permission overwrite granting the bot user `ViewChannel` + `SendMessages`
- The bot's user ID comes from `client.user.id` after login (the same bot whose token disclaw uses)
- `addBot: true` on a public channel is a validation warning (unnecessary)
- `private: true` without `addBot` is valid (locked channel)

## Discord Implementation

`private` and `addBot` map to Discord permission overwrites:

```
private: true  ->  PermissionOverwrite: deny @everyone ViewChannel
addBot: true   ->  PermissionOverwrite: allow bot_user_id ViewChannel + SendMessages
```

- **Create**: pass `permissionOverwrites` array to `guild.channels.create()`
- **Update**: call `ch.permissionOverwrites.set()` to replace overwrites
- **Diff**: compare current overwrites against desired state

The bot user ID is available as `client.user.id` after `client.login()`. The DiscordProvider needs to expose this so the reconciler/apply logic can use it.

## Files to Modify

**`src/types.ts`**:
- `DesiredChannel`: add `private?: boolean`, `addBot?: boolean`
- `FlatDesiredChannel`: add `private?: boolean`, `addBot?: boolean`
- `ActualChannel`: add `private?: boolean`, `addBot?: boolean`

**`src/parser.ts`**:
- `ChannelSchema`: add `private: z.boolean().optional()`, `addBot: z.boolean().optional()`
- `validateDesiredState()`: warn if `addBot: true` without `private: true`
- `flattenDesiredState()`: forward `private` and `addBot` into flat channel

**`src/reconciler.ts`**:
- Channel diff: add `privateChanged` and `addBotChanged` checks
- Include in `details.before/after`
- Create action: include `private` and `addBot` in `details.after`

**`src/providers/discord.ts`**:
- `fetch()`: detect `@everyone` deny ViewChannel -> `private: true`, detect bot user overwrite -> `addBot: true`
- `apply()` create: build `permissionOverwrites` array from `private` + `addBot`
- `apply()` update: call `ch.permissionOverwrites.set()` when overwrites change
- Expose `getBotUserId()` method (returns `client.user?.id`)

**`src/commands/import.ts`**: forward `private` and `addBot` from ActualChannel into YAML node

**`src/format.ts`**: no changes needed (generic key renderer handles new fields)

## Validation Rules

- `addBot: true` without `private: true` -> warning (bot already has access to public channels)
- `private` and `addBot` are both optional, default `false`/absent

## Reconciler Behavior

- `privateChanged`: triggers update action, overwrites recalculated
- `addBotChanged`: triggers update action, overwrites recalculated
- Both changes surface in `details.before/after` for diff display
