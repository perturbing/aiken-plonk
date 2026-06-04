{
  description = "An aiken plonk verifier using Circom and SnarkJS";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    snarkjs-cardano.url = "github:perturbing/snarkjs-cardano/42eb57674042f9f14c5aee265bb49822119701f6";
    aiken.url = "github:aiken-lang/aiken/v1.1.19";
  };

  outputs = { self, nixpkgs, flake-utils, snarkjs-cardano, aiken }:
    flake-utils.lib.eachSystem [ "x86_64-linux" "x86_64-darwin" "aarch64-darwin" ] (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in {
        devShells.default = pkgs.mkShell {
          packages = [
            aiken.packages.${system}.aiken
            snarkjs-cardano.defaultPackage.${system}
            pkgs.circom
            pkgs.nodejs
            pkgs.jq
            pkgs.cargo
            pkgs.rustc
          ];
        };
      });

  nixConfig = {
    extra-substituters = [
      "https://cache.iog.io"
    ];
    extra-trusted-public-keys = [
      "hydra.iohk.io:f/Ea+s+dFdN+3Y/G+FDgSq+a5NEWhJGzdjvKNGv0/EQ="
    ];
  };
}
