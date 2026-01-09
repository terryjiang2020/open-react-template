import Link from "next/link";
import Image from "next/image";
import logo from "@/public/images/logo.svg";

export default function Logo({ className }: { className?: string }) {
  return (
    <Link href="/" className={`inline-flex shrink-0 ${className}`} aria-label="Cruip">
      <Image src={logo} alt="Cruip Logo" width={32} height={32} />
    </Link>
  );
}
