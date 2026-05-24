import "./index.css";
import { Composition, staticFile } from "remotion";
import { CaptionedVideo, calculateCaptionedVideoMetadata } from "./CaptionedVideo";
import { captionedVideoSchema } from "./schema";

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="CaptionedVideo"
      component={CaptionedVideo}
      calculateMetadata={calculateCaptionedVideoMetadata}
      schema={captionedVideoSchema}
      width={1080}
      height={1920}
      defaultProps={{
        src: staticFile("reel.mp4"),
        musicVolume: 0.18,
      }}
    />
  );
};
