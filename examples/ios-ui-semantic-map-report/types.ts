export interface IosUiSemanticMapReportInput {
  readonly graphPath: string;
  readonly htmlPath: string;
  readonly discoveryStatePath?: string;
  readonly graphOutputPath?: string;
  readonly assetsDirectory?: string;
  readonly summaryPath?: string;
  readonly scriptPath?: string;
  readonly title?: string;
}

export interface IosUiSemanticMapReportResult {
  readonly success: boolean;
  readonly graphPath: string;
  readonly graphOutputPath: string;
  readonly htmlPath: string;
  readonly scriptPath: string;
  readonly assetsDirectory: string;
  readonly summaryPath: string;
  readonly sceneCount: number;
  readonly elementCount: number;
  readonly operatorCount: number;
  readonly taskCount: number;
  readonly stateVariantCount: number;
}
