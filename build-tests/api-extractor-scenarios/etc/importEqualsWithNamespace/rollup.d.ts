import Inner2 = Lib1Namespace.Inner;
import { Lib1Interface } from 'api-extractor-lib1-test';
import { Lib1Namespace } from 'api-extractor-lib1-test';
import LocalNSClass2 = LocalNS.LocalNSClass;
import Y2 = Lib1Namespace.Y;

export declare interface Item {
    externalImport: Inner2.X;
    externalImport2: Y2;
    externalImport3: typeof Lib1Namespace;
    localImportFromAstModule: LocalClass;
    localImportFromNamespace: LocalNSClass2;
    reExport: Lib1Interface;
}

declare class LocalClass {
}

declare namespace LocalNS {
    class LocalNSClass {
        innerLocalImport: LocalClass;
        innerExternalImport: Y2;
    }
}

export { }
