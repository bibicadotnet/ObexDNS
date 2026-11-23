import React from "react";
import { useLocation } from "react-router-dom";
import type { UserInfo } from "../../../types/auth";
import { BrandLogoHeader } from "../../../components/BrandLogoHeader";
import { GlobalHeaderActions } from "../../../components/GlobalHeaderActions";

interface NavbarProps {
  isMobile: boolean;
  navigate: (path: string) => void;
  handleLogout: () => void;
  currentUser?: UserInfo | null;
}

export const Navbar: React.FC<NavbarProps> = ({ navigate, handleLogout, currentUser }) => {
  const location = useLocation();

  return (
    <header className="sticky top-0 z-30 h-14 border-b border-[#d0d7de] bg-white/90 backdrop-blur-md flex items-center justify-between px-4 shrink-0">
      <BrandLogoHeader onClick={() => navigate("/dash")} />
      <GlobalHeaderActions
        currentUser={currentUser}
        navigate={navigate}
        location={location}
        handleLogout={handleLogout}
      />
    </header>
  );
};
