import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { SymbolView } from "../../components/AppSymbol";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { MaterialNewThreadButton } from "../../components/MaterialNewThreadButton";

export function WorkspaceEmptyDetail(props: { readonly onStartNewTask?: () => void }) {
  const { materialYouStyleLayoutActive } = useAppearancePreferences();
  return (
    <View
      className={
        materialYouStyleLayoutActive
          ? "flex-1 items-center justify-center px-10"
          : "flex-1 items-center justify-center bg-screen px-10"
      }
    >
      <View className="max-w-[360px] items-center gap-3">
        <SymbolView
          name="sidebar.left"
          size={34}
          tintColorClassName={"accent-icon-subtle"}
          type="hierarchical"
        />
        <Text className="text-center text-xl font-t3-bold">Select a thread</Text>
        <Text className="text-center text-base text-foreground-muted">
          {materialYouStyleLayoutActive
            ? "Choose a thread from the sidebar or start a new thread."
            : "Choose a thread from the sidebar or start a new task."}
        </Text>
        {props.onStartNewTask ? (
          materialYouStyleLayoutActive ? (
            <MaterialNewThreadButton extended className="mt-2" onPress={props.onStartNewTask} />
          ) : (
            <Pressable
              accessibilityRole="button"
              className="mt-2 flex-row items-center gap-2 rounded-full bg-primary px-5 py-3 active:opacity-70"
              onPress={props.onStartNewTask}
            >
              <Text className="text-base font-t3-bold text-primary-foreground">New Task</Text>
            </Pressable>
          )
        ) : null}
      </View>
    </View>
  );
}
