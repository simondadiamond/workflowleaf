import type { ComponentProps } from "react";
import { MaterialFloatingActionButton } from "./MaterialFloatingActionButton.android";
import type { MaterialNewThreadButton as SharedMaterialNewThreadButton } from "./MaterialNewThreadButton.shared";

export function MaterialNewThreadButton(
  props: ComponentProps<typeof SharedMaterialNewThreadButton>,
) {
  return (
    <MaterialFloatingActionButton
      {...props}
      icon="square.and.pencil"
      label="New thread"
      variant={props.extended ? "extended" : "large"}
    />
  );
}
