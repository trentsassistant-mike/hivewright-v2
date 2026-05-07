// @vitest-environment jsdom
import { describe, it } from "vitest";
import { render } from "@testing-library/react";
import { useQuery } from "@tanstack/react-query";
import { Providers } from "../../src/app/providers";

function Probe() {
  const { data } = useQuery({
    queryKey: ["probe"],
    queryFn: async () => "hello",
  });
  return <span data-testid="probe">{data ?? "loading"}</span>;
}

describe("Providers", () => {
  it("provides a QueryClient context for useQuery hooks that resolve", async () => {
    const { findByText } = render(
      <Providers>
        <Probe />
      </Providers>,
    );
    await findByText("hello");
  });
});
