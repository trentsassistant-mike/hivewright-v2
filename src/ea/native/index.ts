import type { Sql } from "postgres";
import { REST, Routes, SlashCommandBuilder } from "discord.js";
import { startNativeEa, type NativeEaHandle } from "./connector";
import { normalizeEaModel } from "./runner";
import { decrypt } from "../../credentials/encryption";

/**
 * Dispatcher-facing entry point. Reads every active `ea-discord`
 * connector install from the DB, decrypts its bot token, registers
 * slash commands (idempotent), and starts one NativeEaHandle per
 * install. The dispatcher keeps the handles in its shutdownCallbacks
 * so SIGTERM tears them all down cleanly.
 *
 * The env-driven path is gone — config lives on connector_installs +
 * credentials, owned by the owner via the standard Connectors UI at
 * /setup/connectors. Installing the "HiveWright EA (Discord)"
 * connector with a bot token / app ID / channel ID + restarting the
 * dispatcher is the whole user flow.
 */

interface EaInstallRow {
  id: string;
  hive_id: string;
  config: {
    applicationId?: string;
    channelId?: string;
    guildId?: string;
    model?: string;
  };
  credential_id: string | null;
}

export async function maybeStartNativeEa(sql: Sql): Promise<NativeEaHandle[]> {
  const installs = (await sql`
    SELECT id, hive_id, config, credential_id
    FROM connector_installs
    WHERE connector_slug = 'ea-discord' AND status = 'active'
  `) as unknown as EaInstallRow[];

  if (installs.length === 0) return [];

  const encryptionKey = process.env.ENCRYPTION_KEY ?? "";
  if (!encryptionKey) {
    console.error(
      `[ea-native] ${installs.length} ea-discord install(s) found but ENCRYPTION_KEY is not set; skipping.`,
    );
    return [];
  }

  const apiBaseUrl =
    process.env.NEXT_PUBLIC_DASHBOARD_URL ?? `http://localhost:${process.env.PORT ?? 3002}`;
  const workspacePath = process.env.EA_WORKSPACE_PATH ?? process.cwd();

  const handles: NativeEaHandle[] = [];
  for (const install of installs) {
    const appId = install.config?.applicationId;
    const channelId = install.config?.channelId;
    if (!appId || !channelId) {
      console.error(
        `[ea-native] install ${install.id.slice(0, 8)} missing applicationId or channelId; skipping.`,
      );
      continue;
    }
    if (!install.credential_id) {
      console.error(
        `[ea-native] install ${install.id.slice(0, 8)} has no credential attached; skipping.`,
      );
      continue;
    }

    let botToken: string;
    try {
      const [cred] = (await sql`
        SELECT value FROM credentials WHERE id = ${install.credential_id}
      `) as unknown as { value: string }[];
      if (!cred) {
        console.error(`[ea-native] credential ${install.credential_id} not found; skipping install ${install.id.slice(0, 8)}.`);
        continue;
      }
      const parsed = JSON.parse(decrypt(cred.value, encryptionKey)) as Record<string, string>;
      if (!parsed.botToken) {
        console.error(`[ea-native] install ${install.id.slice(0, 8)} credential missing botToken field; skipping.`);
        continue;
      }
      botToken = parsed.botToken;
    } catch (err) {
      console.error(`[ea-native] failed to decrypt credential for install ${install.id.slice(0, 8)}:`, err);
      continue;
    }

    // Idempotently register /status and /new for this application.
    // Guild-scoped registration if guildId set (dev-friendly, instant
    // propagation), otherwise global (~1h propagation).
    try {
      await registerSlashCommands(botToken, appId, install.config.guildId);
    } catch (err) {
      console.error(
        `[ea-native] slash command registration failed for install ${install.id.slice(0, 8)}:`,
        err,
      );
      // Non-fatal — the gateway will still start, commands just won't work until next boot.
    }

    const model = normalizeEaModel(install.config.model);
    console.log(
      `[ea-native] starting install ${install.id.slice(0, 8)} (hive=${install.hive_id.slice(0, 8)}..., channel=${channelId}, model=${model ?? "runtime-default"})`,
    );
    try {
      const handle = await startNativeEa(sql, {
        discordToken: botToken,
        hiveId: install.hive_id,
        channelId,
        apiBaseUrl,
        model,
        workspacePath,
      });
      handles.push(handle);
    } catch (err) {
      console.error(`[ea-native] startNativeEa failed for install ${install.id.slice(0, 8)}:`, err);
    }
  }

  return handles;
}

async function registerSlashCommands(
  botToken: string,
  appId: string,
  guildId: string | null | undefined,
): Promise<void> {
  const commands = [
    new SlashCommandBuilder()
      .setName("status")
      .setDescription("Show current HiveWright status — active goals, pending decisions, stuck tasks.")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("new")
      .setDescription("End the current conversation thread and start fresh.")
      .toJSON(),
  ];
  const rest = new REST({ version: "10" }).setToken(botToken);
  const route =
    guildId && guildId.trim().length > 0
      ? Routes.applicationGuildCommands(appId, guildId)
      : Routes.applicationCommands(appId);
  await rest.put(route, { body: commands });
}

export type { NativeEaHandle } from "./connector";
