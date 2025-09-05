import { Lib1Namespace } from 'api-extractor-lib1-test';
import * as LocalModule from './local-module';
export { LocalModule };

export namespace LocalNS {
  import LocalClass2 = LocalModule.LocalClass;
  import ExternalClass2 = Lib1Namespace.Y;

  export class LocalNSClass {
    innerLocalImport: LocalClass2;
    innerExternalImport: ExternalClass2;
  }
}
