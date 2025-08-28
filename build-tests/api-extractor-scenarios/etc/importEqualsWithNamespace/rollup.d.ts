import Inner = Lib1Namespace.Inner;
import { Lib1Interface } from 'api-extractor-lib1-test';
import { Lib1Namespace } from 'api-extractor-lib1-test';
import LocalNSClass = LocalNS.LocalNSClass;
import Y = Lib1Namespace.Y;

export declare interface Item {
    externalImport: Inner.X;
    externalImport2: Y;
    externalImport3: typeof Lib1Namespace;
    localImportFromAstModule: LocalClass;
    localImportFromNamespace: LocalNSClass;
    reExport: Lib1Interface;
}

declare class LocalClass {
}

declare namespace LocalNS {
    class LocalNSClass {
    }
}

export { }
