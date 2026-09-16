import type { ComponentProps } from "react";
import { ScrollView } from "react-native";

import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";

/** Keeps forms and settings readable inside a wide pane while its surface fills the screen. */
export function ScreenScrollView(props: ComponentProps<typeof ScrollView>) {
  const { materialYouStyleLayoutActive } = useAppearancePreferences();
  return (
    <ScrollView
      {...props}
      contentContainerStyle={[
        props.contentContainerStyle,
        materialYouStyleLayoutActive && {
          width: "100%",
          maxWidth: 720,
          alignSelf: "center",
        },
      ]}
    />
  );
}
