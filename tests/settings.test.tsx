import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_GENERATION_SETTINGS,
  followUpSettings,
  followUpSettingsSchema,
} from "../shared/contracts";
import { SettingsScreen } from "../client/settings";

const mock = vi.hoisted(() => ({ state: {} as unknown }));
vi.mock("@getpaseo/plugin/client", () => ({ useSettings: () => mock.state }));
vi.mock("react-native", () => ({
  Text: "Text",
  ScrollView: "ScrollView",
  View: "View",
  Pressable: "Pressable",
  TextInput: "TextInput",
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let rendered: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => rendered?.unmount());
  rendered = undefined;
});

const props = {
  host: { id: "host-1", label: "Test host" },
  theme: { colors: { foreground: "black", surface0: "white" } },
  supported: true,
} as PluginSurfaceProps & { supported: boolean };

describe("host model settings", () => {
  it("defaults to Terra low and migrates old disabled settings without re-enabling them", async () => {
    expect(followUpSettingsSchema.parse(undefined)).toEqual({
      enabled: true,
      model: "gpt-6.1-terra",
      reasoningEffort: "low",
    });
    expect(await followUpSettings.migrate?.({ enabled: false }, 1)).toEqual({
      enabled: false,
      ...DEFAULT_GENERATION_SETTINGS,
    });
  });
  it.each(["", "model with spaces", "--model=other", "x".repeat(201)])(
    "rejects invalid model IDs: %s",
    (model) => expect(followUpSettingsSchema.safeParse({ model }).success).toBe(false),
  );
  it("rejects thinking levels that can enable delegation", () => {
    expect(followUpSettingsSchema.safeParse({ reasoningEffort: "ultra" }).success).toBe(false);
  });
  it("saves a trimmed model and thinking level against the displayed revision while preserving disable", async () => {
    const save = vi.fn(async () => true);
    mock.state = {
      status: "ready",
      values: { enabled: false, ...DEFAULT_GENERATION_SETTINGS },
      revision: "revision-1",
      saving: false,
      save,
    };
    await act(async () => {
      rendered = create(<SettingsScreen {...props} />);
    });
    await act(async () => {
      rendered!.root
        .findByProps({ accessibilityLabel: "Model name" })
        .props.onChangeText(" gpt-6-luna ");
      rendered!.root.findByProps({ accessibilityLabel: "medium thinking" }).props.onPress();
    });
    await act(async () => {
      rendered!.root.findByProps({ accessibilityLabel: "Save model settings" }).props.onPress();
    });
    expect(save).toHaveBeenCalledWith(
      { enabled: false, model: "gpt-6-luna", reasoningEffort: "medium" },
      "revision-1",
    );
  });
  it("preserves a selected model and thinking level when disabling suggestions", async () => {
    const save = vi.fn(async () => true);
    mock.state = {
      status: "ready",
      values: { enabled: true, model: "gpt-6-luna", reasoningEffort: "high" },
      revision: "revision-2",
      saving: false,
      save,
    };
    await act(async () => {
      rendered = create(<SettingsScreen {...props} />);
    });
    await act(async () => {
      rendered!.root.findByProps({ accessibilityRole: "switch" }).props.onPress();
    });
    expect(save).toHaveBeenCalledWith(
      { enabled: false, model: "gpt-6-luna", reasoningEffort: "high" },
      "revision-2",
    );
  });
});
