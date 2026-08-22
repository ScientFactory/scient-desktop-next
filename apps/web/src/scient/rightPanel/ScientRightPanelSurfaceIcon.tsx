import { File, FileText, Image as ImageIcon, Library, Sigma } from "lucide-react";

import type { ScientRightPanelSurface } from "./surfaces";

export function ScientRightPanelSurfaceIcon(props: { readonly surface: ScientRightPanelSurface }) {
  switch (props.surface.module) {
    case "sources":
      return <Library className="size-3 shrink-0" />;
    case "compute":
      return <Sigma className="size-3 shrink-0" />;
    case "source-pdf":
      return <FileText className="size-3 shrink-0" />;
    case "artifact":
      return <ImageIcon className="size-3 shrink-0" />;
    case "file":
      return <File className="size-3 shrink-0" />;
  }
}
