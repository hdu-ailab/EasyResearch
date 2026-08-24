export type ThirdPartyLicenseOverride =
  | { license: string; requiredLicenseFile: string }
  | { license: string; readmeFile: string; heading: string }
  | {
      license: string;
      upstreamUrl: string;
      upstreamSha256: string;
      licenseTextFile: string;
    };

export const THIRD_PARTY_LICENSE_OVERRIDES: Readonly<
  Record<string, ThirdPartyLicenseOverride>
> = {
  "open-websearch@2.1.11": {
    license: "Apache-2.0",
    requiredLicenseFile: "LICENSE",
  },
  "boolbase@1.0.0": {
    license: "ISC",
    upstreamUrl:
      "https://raw.githubusercontent.com/fb55/boolbase/54811f01c797a6bb1c263183ae90b7dd627e0638/LICENSE",
    upstreamSha256: "cdf4d87ae0a6c160227263bf4e39a0a10e30e89ae7256e0f7ac7bde0836552c6",
    licenseTextFile: "scripts/licenses/boolbase-1.0.0.txt",
  },
  "saxes@6.0.0": {
    license: "ISC",
    upstreamUrl: "https://raw.githubusercontent.com/lddubeau/saxes/v6.0.0/LICENSE",
    upstreamSha256: "0fac2374380621b22e6b50451057721a9c52935b02d16d106a9f04897f061d0e",
    licenseTextFile: "scripts/licenses/saxes-6.0.0.txt",
  },
  "cookie-signature@1.0.7": {
    license: "MIT",
    readmeFile: "Readme.md",
    heading: "## License",
  },
  "https-proxy-agent@5.0.1": {
    license: "MIT",
    readmeFile: "README.md",
    heading: "License\n-------",
  },
  "agent-base@6.0.2": {
    license: "MIT",
    readmeFile: "README.md",
    heading: "License\n-------",
  },
};
