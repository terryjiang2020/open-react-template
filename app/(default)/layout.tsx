"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

import AOS from "aos";
import "aos/dist/aos.css";

import Footer from "@/components/ui/footer";

export default function DefaultLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const isDashboard = pathname?.startsWith("/dashboard");

  useEffect(() => {
    AOS.init({
      once: true,
      disable: "phone",
      duration: 600,
      easing: "ease-out-sine",
    });
  });

  return (
    <>
      <main className="relative flex grow flex-col">{children}</main>

      {!isDashboard && <Footer />}
    </>
  );
}
